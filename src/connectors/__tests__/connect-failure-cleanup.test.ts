import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * A connect() that fails after creating its pool must close it.
 *
 * `ConnectorManager.connectSource` only registers a connector in `this.connectors`
 * *after* connect() resolves, so a pool stranded by a failed attempt is never
 * reachable from `disconnect()`. Lazy sources retry on every tool call, so an
 * unreachable database would otherwise strand a fresh pool per invocation.
 */

const mysqlCreatePool = vi.fn();
const mariadbCreatePool = vi.fn();
const pgPoolCtor = vi.fn();

vi.mock("mysql2/promise", () => ({
  default: {
    get createPool() {
      return mysqlCreatePool;
    },
  },
}));

vi.mock("mariadb", () => ({
  createPool: (...args: any[]) => mariadbCreatePool(...args),
}));

vi.mock("pg", () => ({
  default: {
    Pool: function (this: any, ...args: any[]) {
      return pgPoolCtor(...args);
    },
  },
}));

const mssqlPoolCtor = vi.fn();

vi.mock("mssql", () => ({
  default: {
    ConnectionPool: function (this: any, ...args: any[]) {
      return mssqlPoolCtor(...args);
    },
  },
}));

const { MySQLConnector } = await import("../mysql/index.js");
const { MariaDBConnector } = await import("../mariadb/index.js");
const { PostgresConnector } = await import("../postgres/index.js");

const PROBE_FAILURE = new Error("ECONNREFUSED");

describe("connect() failure cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The connectors log the failure; keep test output readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("MySQL closes the pool when the version probe fails", async () => {
    const end = vi.fn();
    mysqlCreatePool.mockReturnValue({
      query: vi.fn().mockRejectedValue(PROBE_FAILURE),
      end,
    });

    const connector = new MySQLConnector();
    await expect(connector.connect("mysql://u:p@localhost:3306/db")).rejects.toThrow(
      "ECONNREFUSED"
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("MariaDB closes the pool when the version probe fails", async () => {
    const end = vi.fn();
    mariadbCreatePool.mockReturnValue({
      query: vi.fn().mockRejectedValue(PROBE_FAILURE),
      end,
    });

    const connector = new MariaDBConnector();
    await expect(connector.connect("mariadb://u:p@localhost:3306/db")).rejects.toThrow(
      "ECONNREFUSED"
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("PostgreSQL closes the pool when the connection probe fails", async () => {
    const end = vi.fn();
    pgPoolCtor.mockReturnValue({
      connect: vi.fn().mockRejectedValue(PROBE_FAILURE),
      end,
    });

    const connector = new PostgresConnector();
    await expect(connector.connect("postgres://u:p@localhost:5432/db")).rejects.toThrow(
      "ECONNREFUSED"
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original error even when teardown itself fails", async () => {
    const end = vi.fn().mockRejectedValue(new Error("pool.end exploded"));
    mysqlCreatePool.mockReturnValue({
      query: vi.fn().mockRejectedValue(PROBE_FAILURE),
      end,
    });

    const connector = new MySQLConnector();
    // The connection error is the diagnostic one; a noisy teardown must not mask it.
    await expect(connector.connect("mysql://u:p@localhost:3306/db")).rejects.toThrow(
      "ECONNREFUSED"
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("SQL Server closes the pool when the connection probe fails", async () => {
    const { SQLServerConnector } = await import("../sqlserver/index.js");
    const close = vi.fn();
    mssqlPoolCtor.mockReturnValue({
      connect: vi.fn().mockRejectedValue(PROBE_FAILURE),
      close,
    });

    const connector = new SQLServerConnector();
    await expect(connector.connect("sqlserver://u:p@localhost:1433/db")).rejects.toThrow(
      "ECONNREFUSED"
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("SQLite releases the handle when the init script fails", async () => {
    // Real node:sqlite (not mocked): the handle opens fine, then exec() throws.
    const { SQLiteConnector } = await import("../sqlite/index.js");
    const dbPath = path.join(os.tmpdir(), `dbhub-cleanup-${process.pid}.db`);
    const connector = new SQLiteConnector();

    try {
      await expect(
        connector.connect(`sqlite:///${dbPath}`, "THIS IS NOT VALID SQL;")
      ).rejects.toThrow();

      // Handle released -> the connector reports itself disconnected rather than
      // holding an open database it can never close.
      await expect(connector.executeSQL("SELECT 1", {})).rejects.toThrow(/not connected/i);
    } finally {
      await fs.promises.rm(dbPath, { force: true });
    }
  });

  it("repeated failed attempts do not strand pools", async () => {
    const ends: ReturnType<typeof vi.fn>[] = [];
    mysqlCreatePool.mockImplementation(() => {
      const end = vi.fn();
      ends.push(end);
      return { query: vi.fn().mockRejectedValue(PROBE_FAILURE), end };
    });

    // Mirrors a lazy source retrying on each tool call.
    const connector = new MySQLConnector();
    for (let i = 0; i < 3; i++) {
      await expect(connector.connect("mysql://u:p@localhost:3306/db")).rejects.toThrow();
    }

    expect(ends).toHaveLength(3);
    expect(ends.every((end) => end.mock.calls.length === 1)).toBe(true);
  });
});
