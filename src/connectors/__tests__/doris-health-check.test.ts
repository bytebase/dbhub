import { describe, it, expect, vi } from "vitest";
import { getDorisHealthCheck, DorisHealthCheckError } from "../doris-health-check.js";

describe("Doris diagnostics", () => {
  it("collects visible sessions and preserves native node rows using only three queries", async () => {
    const frontends = [{ Name: "fe", Alive: "false", Extra: 42n }];
    const backends = [
      { BackendId: "123", Alive: "false", TotalCapacity: "1.000 B", UsedPct: "0.00 %" },
    ];
    const query = vi.fn(async (sql: string) =>
      sql === "SHOW FRONTENDS"
        ? frontends
        : sql === "SHOW BACKENDS"
          ? backends
          : [{ total: "5", active: 2n, idle: "3", longest_active_query_seconds: "12" }]
    );
    const health = await getDorisHealthCheck(query);
    expect(query).toHaveBeenCalledTimes(3);
    const sql = query.mock.calls.map(([sql]) => sql).join("\n");
    expect(sql).toContain("information_schema.PROCESSLIST");
    expect(sql).toContain("WHERE ID <> CONNECTION_ID()");
    expect(query.mock.calls[0][0].replace(/\s+/g, " ").trim()).toBe(
      "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN COMMAND != 'Sleep' THEN 1 ELSE 0 END), 0) AS active, COALESCE(SUM(CASE WHEN COMMAND = 'Sleep' THEN 1 ELSE 0 END), 0) AS idle, MAX(CASE WHEN COMMAND != 'Sleep' THEN TIME ELSE NULL END) AS longest_active_query_seconds FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID()"
    );
    expect(sql).not.toMatch(
      /INNODB_TRX|SHOW GLOBAL STATUS|max_connections|version_comment|VERSION\(\)/i
    );
    expect(health.connections).toEqual({
      total: 5,
      active: 2,
      idle: 3,
      idleInTransaction: null,
      maxConnections: null,
      longestIdleInTransactionSeconds: null,
      longestActiveQuerySeconds: 12,
    });
    expect(health.nodes?.frontends).toBe(frontends);
    expect(health.nodes?.backends).toBe(backends);
    expect(health).not.toHaveProperty("bufferCache");
    expect(health.notes?.join(" ")).toMatch(/visible sessions/);
    expect(health.notes?.join(" ")).toMatch(/empty node lists/i);
  });

  it("preserves empty node lists, zero counts and a null active duration", async () => {
    const health = await getDorisHealthCheck(async (sql) =>
      sql.includes("PROCESSLIST")
        ? [{ total: 0, active: 0, idle: 0, longest_active_query_seconds: null }]
        : []
    );
    expect(health.nodes).toEqual({ frontends: [], backends: [] });
    expect(health.connections).toMatchObject({
      total: 0,
      active: 0,
      idle: 0,
      longestActiveQuerySeconds: null,
    });
  });

  it.each([
    ["PROCESSLIST", "connections"],
    ["SHOW FRONTENDS", "frontends"],
    ["SHOW BACKENDS", "backends"],
  ])("fails the whole collection on %s with the original error", async (statement, section) => {
    const original = Object.assign(new Error("permission denied"), {
      code: "ECONNRESET",
      errno: 1045,
      __dbhubSSHTunnelError: true,
    });
    const result = getDorisHealthCheck(async (sql) => {
      if (sql.includes(statement)) throw original;
      return [];
    });
    await expect(result).rejects.toThrow(`Doris health check ${section} failed: permission denied`);
    await expect(result).rejects.toMatchObject({
      name: "DorisHealthCheckError",
      section,
      originalError: original,
    });
    await expect(result).rejects.toBeInstanceOf(DorisHealthCheckError);
    await result.catch((error) => expect(error.originalError).toBe(original));
  });

  it("labels non-Error rejections", async () => {
    await expect(
      getDorisHealthCheck(async () => {
        throw "denied";
      })
    ).rejects.toThrow("Doris health check connections failed: denied");
  });

  it("starts all three diagnostic queries before awaiting their results", async () => {
    const resolveQueries: ((rows: any[]) => void)[] = [];
    const query = vi.fn(() => new Promise<any[]>((resolve) => resolveQueries.push(resolve)));
    const health = getDorisHealthCheck(query);
    expect(query).toHaveBeenCalledTimes(3);
    resolveQueries[0]([{ total: 0, active: 0, idle: 0, longest_active_query_seconds: null }]);
    resolveQueries[1]([]);
    resolveQueries[2]([]);
    await expect(health).resolves.toMatchObject({ nodes: { frontends: [], backends: [] } });
  });
});
