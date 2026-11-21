import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types/config.js";

describe("PostgreSQL parser load failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("libpg-query");
    vi.resetModules();
  });

  // Every dialect's classifier imports this module, so a parser that cannot
  // load must not stop the import, only PostgreSQL parsing.
  it("is raised when PostgreSQL SQL is parsed, not at import", async () => {
    vi.resetModules();
    vi.doMock("libpg-query", () => ({
      loadModule: () => Promise.reject(new Error("wasm asset missing")),
    }));

    const { classifyPostgresSQL } = await import("../postgres-sql.js");
    const { classifySQL } = await import("../sql-access-policy.js");

    expect(classifySQL("SELECT 1", "sqlite")).toBe("read");
    expect(() => classifyPostgresSQL("SELECT 1")).toThrow(
      "The PostgreSQL SQL parser (libpg-query) failed to load: wasm asset missing"
    );
  });

  // Lazy sources never connect here, so only the registration check can fail.
  it("stops a PostgreSQL source at registration, and no other source", async () => {
    vi.resetModules();
    vi.doMock("libpg-query", () => ({
      loadModule: () => Promise.reject(new Error("wasm asset missing")),
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { ConnectorManager } = await import("../../connectors/manager.js");
    const manager = new ConnectorManager();
    const sqlite: SourceConfig = { id: "local", type: "sqlite", dsn: "sqlite:///:memory:", lazy: true };
    const postgres: SourceConfig = {
      id: "pg",
      type: "postgres",
      dsn: "postgres://user:secret@localhost:5432/app",
      lazy: true,
    };

    await expect(manager.connectWithSources([sqlite])).resolves.toBeUndefined();
    await expect(manager.addSource(postgres)).rejects.toThrow("failed to load: wasm asset missing");
    await expect(new ConnectorManager().connectWithSources([sqlite, postgres])).rejects.toThrow(
      "failed to load: wasm asset missing"
    );
    expect(manager.getSourceIds()).toEqual(["local"]);
  });
});
