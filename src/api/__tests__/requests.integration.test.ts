import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import express, { Application } from "express";
import { Server } from "http";
import { requestStore, Request } from "../../requests/index.js";
import { listRequests } from "../requests.js";

function createRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sourceId: "test_db",
    toolName: "execute_sql_test_db",
    sql: "SELECT 1",
    durationMs: 10,
    client: "test-client",
    success: true,
    ...overrides,
  };
}

/**
 * The handler is a pass-through: it reads `?source_id`, asks the request store,
 * and wraps the result as `{ requests, total }`. Filtering, ordering and
 * eviction are the store's job and are tested in requests/__tests__/store.test.ts;
 * these tests cover the HTTP wiring only.
 */
describe("GET /api/requests", () => {
  let app: Application;
  let server: Server;
  let BASE_URL: string;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.get("/api/requests", listRequests);

    // Ephemeral port to avoid conflicts
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not report a bound port");
    }
    BASE_URL = `http://localhost:${address.port}`;
  }, 30000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  beforeEach(() => {
    requestStore.clear();
  });

  it("returns an empty JSON list when nothing has been tracked", async () => {
    const response = await fetch(`${BASE_URL}/api/requests`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ requests: [], total: 0 });
  });

  it("returns every tracked request across sources, with the total", async () => {
    requestStore.add(createRequest({ sourceId: "db1" }));
    requestStore.add(createRequest({ sourceId: "db2" }));
    requestStore.add(createRequest({ sourceId: "db1" }));

    const response = await fetch(`${BASE_URL}/api/requests`);
    expect(response.status).toBe(200);

    const data: any = await response.json();
    expect(data.requests).toHaveLength(3);
    expect(data.total).toBe(3);
  });

  it("returns each request exactly as stored, newest first, including a failed one", async () => {
    const now = Date.now();
    const succeeded = createRequest({
      id: "ok",
      timestamp: new Date(now - 1000).toISOString(),
      sourceId: "prod_db",
      toolName: "execute_sql_prod_db",
      sql: "SELECT * FROM users WHERE name = 'O''Brien'",
      durationMs: 150,
      client: "claude-desktop",
    });
    const failed = createRequest({
      id: "failed",
      timestamp: new Date(now).toISOString(),
      sourceId: "prod_db",
      sql: "SELECT * FROM nonexistent_table",
      durationMs: 0,
      success: false,
      error: 'ERROR: relation "nonexistent_table" does not exist\nLINE 1: SELECT * FROM nonexistent_table',
    });
    requestStore.add(succeeded);
    requestStore.add(failed);

    const data: any = await (await fetch(`${BASE_URL}/api/requests`)).json();

    // `error` is present only on the failed request
    expect(data.requests).toEqual([failed, succeeded]);
    expect(data.requests[1]).not.toHaveProperty("error");
  });

  it("filters by the source_id query parameter", async () => {
    requestStore.add(createRequest({ sourceId: "db1", id: "db1-a" }));
    requestStore.add(createRequest({ sourceId: "db2", id: "db2-a" }));
    requestStore.add(createRequest({ sourceId: "db1", id: "db1-b" }));

    const db1: any = await (await fetch(`${BASE_URL}/api/requests?source_id=db1`)).json();
    expect(db1.total).toBe(2);
    expect(db1.requests.map((r: Request) => r.sourceId)).toEqual(["db1", "db1"]);

    const unknown: any = await (await fetch(`${BASE_URL}/api/requests?source_id=nonexistent`)).json();
    expect(unknown).toEqual({ requests: [], total: 0 });
  });
});
