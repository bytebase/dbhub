import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit coverage for the readonly transaction strategy in the MySQL/MariaDB
 * connectors.
 *
 * The integration tests exercise the MySQL/MariaDB path against real containers,
 * but they cannot cover the TiDB branch (no TiDB container, and TiDB's behavior
 * is precisely that it *rejects* the statement the other engines accept). These
 * tests mock the driver so both branches are asserted at the statement level:
 *
 *   MySQL/MariaDB -> START TRANSACTION READ ONLY ... COMMIT
 *   TiDB          -> START TRANSACTION ... ROLLBACK   (writes discarded)
 */

const mysqlCreatePool = vi.fn();
const mariadbCreatePool = vi.fn();

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

const { MySQLConnector } = await import("../mysql/index.js");
const { MariaDBConnector } = await import("../mariadb/index.js");

const MYSQL_VERSION = "8.0.36";
const MARIADB_VERSION = "11.4.2-MariaDB-ubu2404";
const TIDB_VERSION = "8.0.11-TiDB-v7.5.0";

/** Records every statement issued on the dedicated connection. */
function makeFakePool(version: string, wrapResults: (rows: any[]) => any) {
  const statements: string[] = [];
  const conn = {
    query: vi.fn(async (arg: any) => {
      const sql = typeof arg === "string" ? arg : arg.sql;
      statements.push(sql);
      return wrapResults([{ id: 1 }]);
    }),
    release: vi.fn(),
  };
  const pool = {
    // Connect-time flavor probe.
    query: vi.fn(async () => wrapResults([{ version }])),
    getConnection: vi.fn(async () => conn),
    end: vi.fn(),
  };
  return { pool, conn, statements };
}

// mysql2 returns [rows, fields]; mariadb returns rows directly.
const asMysql = (rows: any[]) => [rows, []];
const asMariadb = (rows: any[]) => rows;

describe("readonly transaction strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("MySQL connector", () => {
    it("uses READ ONLY transaction + COMMIT on stock MySQL", async () => {
      const { pool, statements } = makeFakePool(MYSQL_VERSION, asMysql);
      mysqlCreatePool.mockReturnValue(pool);

      const connector = new MySQLConnector();
      await connector.connect("mysql://user:pass@localhost:3306/db");
      await connector.executeSQL("SELECT 1", { readonly: true });

      expect(statements[0]).toBe("START TRANSACTION READ ONLY");
      expect(statements[statements.length - 1]).toBe("COMMIT");
    });

    it("falls back to a plain transaction + ROLLBACK on TiDB", async () => {
      const { pool, statements } = makeFakePool(TIDB_VERSION, asMysql);
      mysqlCreatePool.mockReturnValue(pool);

      const connector = new MySQLConnector();
      await connector.connect("mysql://user:pass@localhost:3306/db");
      await connector.executeSQL("SELECT 1", { readonly: true });

      // TiDB rejects the READ ONLY modifier, so it must never be sent...
      expect(statements).not.toContain("START TRANSACTION READ ONLY");
      expect(statements[0]).toBe("START TRANSACTION");
      // ...and the transaction is discarded so any missed DML never persists.
      expect(statements[statements.length - 1]).toBe("ROLLBACK");
    });

    it("opens no transaction when readonly is off", async () => {
      const { pool, statements } = makeFakePool(TIDB_VERSION, asMysql);
      mysqlCreatePool.mockReturnValue(pool);

      const connector = new MySQLConnector();
      await connector.connect("mysql://user:pass@localhost:3306/db");
      await connector.executeSQL("SELECT 1", {});

      expect(statements).toEqual(["SELECT 1"]);
    });
  });

  describe("error handling", () => {
    it("rolls back and rethrows when the query fails", async () => {
      const { pool, conn, statements } = makeFakePool(MYSQL_VERSION, asMysql);
      const failure = new Error("syntax error");
      conn.query.mockImplementation(async (arg: any) => {
        const sql = typeof arg === "string" ? arg : arg.sql;
        statements.push(sql);
        if (sql === "SELECT bad") throw failure;
        return asMysql([{ id: 1 }]);
      });
      mysqlCreatePool.mockReturnValue(pool);

      const connector = new MySQLConnector();
      await connector.connect("mysql://user:pass@localhost:3306/db");

      await expect(connector.executeSQL("SELECT bad", { readonly: true })).rejects.toThrow(
        "syntax error"
      );

      // The open transaction must be rolled back so the pooled connection is
      // returned clean, and the original error must survive.
      expect(statements[0]).toBe("START TRANSACTION READ ONLY");
      expect(statements[statements.length - 1]).toBe("ROLLBACK");
      expect(conn.release).toHaveBeenCalled();
    });

    it("attempts a rollback when the transaction fails to open", async () => {
      const { pool, conn, statements } = makeFakePool(MYSQL_VERSION, asMysql);
      conn.query.mockImplementation(async (arg: any) => {
        const sql = typeof arg === "string" ? arg : arg.sql;
        statements.push(sql);
        if (sql === "START TRANSACTION READ ONLY") throw new Error("server gone");
        return asMysql([{ id: 1 }]);
      });
      mysqlCreatePool.mockReturnValue(pool);

      const connector = new MySQLConnector();
      await connector.connect("mysql://user:pass@localhost:3306/db");

      await expect(connector.executeSQL("SELECT 1", { readonly: true })).rejects.toThrow(
        "server gone"
      );

      // A partially-opened transaction must still be rolled back, or the
      // connection returns to the pool with an open transaction.
      expect(statements).toContain("ROLLBACK");
      // The query itself must never run once the read-only guard failed to open.
      expect(statements).not.toContain("SELECT 1");
      expect(conn.release).toHaveBeenCalled();
    });

    it("surfaces the original error even if the rollback also fails", async () => {
      const { pool, conn } = makeFakePool(MYSQL_VERSION, asMysql);
      conn.query.mockImplementation(async (arg: any) => {
        const sql = typeof arg === "string" ? arg : arg.sql;
        if (sql === "SELECT bad") throw new Error("syntax error");
        if (sql === "ROLLBACK") throw new Error("connection lost");
        return asMysql([{ id: 1 }]);
      });
      mysqlCreatePool.mockReturnValue(pool);

      const connector = new MySQLConnector();
      await connector.connect("mysql://user:pass@localhost:3306/db");

      // The rollback failure must not mask the more useful original error.
      await expect(connector.executeSQL("SELECT bad", { readonly: true })).rejects.toThrow(
        "syntax error"
      );
      expect(conn.release).toHaveBeenCalled();
    });
  });

  describe("MariaDB connector", () => {
    it("uses READ ONLY transaction + COMMIT on stock MariaDB", async () => {
      const { pool, statements } = makeFakePool(MARIADB_VERSION, asMariadb);
      mariadbCreatePool.mockReturnValue(pool);

      const connector = new MariaDBConnector();
      await connector.connect("mariadb://user:pass@localhost:3306/db");
      await connector.executeSQL("SELECT 1", { readonly: true });

      expect(statements[0]).toBe("START TRANSACTION READ ONLY");
      expect(statements[statements.length - 1]).toBe("COMMIT");
    });

    it("falls back to a plain transaction + ROLLBACK on TiDB", async () => {
      const { pool, statements } = makeFakePool(TIDB_VERSION, asMariadb);
      mariadbCreatePool.mockReturnValue(pool);

      const connector = new MariaDBConnector();
      await connector.connect("mariadb://user:pass@localhost:3306/db");
      await connector.executeSQL("SELECT 1", { readonly: true });

      expect(statements).not.toContain("START TRANSACTION READ ONLY");
      expect(statements[0]).toBe("START TRANSACTION");
      expect(statements[statements.length - 1]).toBe("ROLLBACK");
    });
  });
});
