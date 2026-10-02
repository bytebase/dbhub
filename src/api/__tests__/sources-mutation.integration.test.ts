import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { Application } from "express";
import { Server } from "http";
import { setupManagerWithFixture, FIXTURES, loadFixtureConfig } from "../../__fixtures__/helpers.js";
import type { ConnectorManager } from "../../connectors/manager.js";
import { listSources, getSource, createSourceMutationHandlers } from "../sources.js";
import { initializeToolRegistry, getToolRegistry } from "../../tools/registry.js";
import { setFileSourceIds } from "../../utils/source-mutation.js";
import type { components } from "../openapi.js";

// Import SQLite connector to ensure it's registered
import "../../connectors/sqlite/index.js";

type DataSource = components["schemas"]["DataSource"];
type ErrorResponse = components["schemas"]["Error"];

const SECRET_DSN = "sqlite:///:memory:";

function buildApp(mutable: boolean): Application {
  const app = express();
  app.use(express.json());
  const { putSource, deleteSource } = createSourceMutationHandlers({ mutable });
  app.get("/api/sources", listSources);
  app.get("/api/sources/:sourceId", getSource);
  app.put("/api/sources/:sourceId", (req, res) => { void putSource(req, res); });
  app.delete("/api/sources/:sourceId", (req, res) => { void deleteSource(req, res); });
  return app;
}

async function listen(app: Application): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, url: `http://localhost:${address.port}` };
}

describe("Sources API mutations", () => {
  let manager: ConnectorManager;
  let mutableServer: Server;
  let immutableServer: Server;
  let BASE_URL: string;
  let LOCKED_URL: string;

  beforeAll(async () => {
    manager = await setupManagerWithFixture(FIXTURES.MULTI_SQLITE);
    const { sources, tools } = loadFixtureConfig(FIXTURES.MULTI_SQLITE);
    initializeToolRegistry({ sources, tools: tools || [] });
    setFileSourceIds(sources.map((s) => s.id));

    ({ server: mutableServer, url: BASE_URL } = await listen(buildApp(true)));
    ({ server: immutableServer, url: LOCKED_URL } = await listen(buildApp(false)));
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((resolve) => mutableServer.close(() => resolve()));
    await new Promise<void>((resolve) => immutableServer.close(() => resolve()));
    await manager.disconnect();
  });

  it("adds a source and its default tools, without echoing the DSN", async () => {
    const response = await fetch(`${BASE_URL}/api/sources/runtime_db`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dsn: SECRET_DSN, description: "added at runtime", lazy: false, max_rows: 50 }),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("sqlite:///");
    expect(JSON.parse(raw)).not.toHaveProperty("dsn");

    const source = JSON.parse(raw) as DataSource;
    expect(source.id).toBe("runtime_db");
    expect(source.type).toBe("sqlite");
    expect(source.description).toBe("added at runtime");
    const executeSql = source.tools.find((t) => t.name.startsWith("execute_sql"));
    expect(executeSql?.readonly).toBe(true);
    expect(executeSql?.max_rows).toBe(50);

    const registered = getToolRegistry().getEnabledToolConfigs("runtime_db").map((t) => t.name);
    expect(registered).toEqual(["execute_sql", "search_objects"]);
  });

  it("lists the runtime source next to the file sources", async () => {
    const response = await fetch(`${BASE_URL}/api/sources`);
    const sources = (await response.json()) as DataSource[];
    expect(sources.map((s) => s.id)).toContain("runtime_db");
    expect(JSON.stringify(sources)).not.toContain("sqlite:///");
  });

  it("replaces a runtime source in place", async () => {
    const response = await fetch(`${BASE_URL}/api/sources/runtime_db`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dsn: SECRET_DSN, description: "replaced", readonly: false }),
    });
    expect(response.status).toBe(200);
    const source = (await response.json()) as DataSource;
    expect(source.description).toBe("replaced");
    expect(source.tools.find((t) => t.name.startsWith("execute_sql"))?.readonly).toBe(false);

    const all = (await (await fetch(`${BASE_URL}/api/sources`)).json()) as DataSource[];
    expect(all.filter((s) => s.id === "runtime_db")).toHaveLength(1);
  });

  it("keeps the file sources queryable while runtime sources change", async () => {
    const result = await manager.getConnector("database_a").executeSQL("SELECT 1 AS one", {});
    expect(Number(result.resultSets[0].rows[0].one)).toBe(1);
  });

  it("removes the runtime source", async () => {
    const response = await fetch(`${BASE_URL}/api/sources/runtime_db`, { method: "DELETE" });
    expect(response.status).toBe(204);

    const gone = await fetch(`${BASE_URL}/api/sources/runtime_db`);
    expect(gone.status).toBe(404);
    expect(getToolRegistry().getEnabledToolConfigs("runtime_db")).toEqual([]);
  });

  it("returns 404 when deleting an unknown source", async () => {
    const response = await fetch(`${BASE_URL}/api/sources/never_existed`, { method: "DELETE" });
    expect(response.status).toBe(404);
  });

  it("refuses to change a source defined by the startup configuration", async () => {
    const put = await fetch(`${BASE_URL}/api/sources/database_a`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dsn: SECRET_DSN }),
    });
    expect(put.status).toBe(409);
    const del = await fetch(`${BASE_URL}/api/sources/database_a`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect(manager.hasSource("database_a")).toBe(true);
  });

  it("rejects invalid bodies and ids", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["no_dsn", { description: "x" }, "'dsn' is required"],
      ["array_body", [{ dsn: SECRET_DSN }], "JSON object"],
      ["bad_scheme", { dsn: "ftp://nowhere/db" }, "not supported"],
      ["bad_lazy", { dsn: SECRET_DSN, lazy: "yes" }, "'lazy' must be a boolean"],
      ["bad_rows", { dsn: SECRET_DSN, max_rows: 0 }, "'max_rows' must be a positive integer"],
    ];
    for (const [id, body, message] of cases) {
      const response = await fetch(`${BASE_URL}/api/sources/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, id).toBe(400);
      const error = (await response.json()) as ErrorResponse;
      expect(error.error, id).toContain(message);
    }

    const badId = await fetch(`${BASE_URL}/api/sources/${encodeURIComponent("has space")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dsn: SECRET_DSN }),
    });
    expect(badId.status).toBe(400);
  });

  it("refuses mutations when the server has no bearer token", async () => {
    const put = await fetch(`${LOCKED_URL}/api/sources/runtime_db`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dsn: SECRET_DSN }),
    });
    expect(put.status).toBe(403);
    const del = await fetch(`${LOCKED_URL}/api/sources/database_a`, { method: "DELETE" });
    expect(del.status).toBe(403);
    expect(manager.hasSource("runtime_db")).toBe(false);
  });
});
