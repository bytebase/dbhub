import { afterEach, describe, expect, it, vi } from "vitest";

describe("PostgreSQL parser load failure", () => {
  afterEach(() => {
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
});
