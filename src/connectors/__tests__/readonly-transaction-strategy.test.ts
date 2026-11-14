import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CLIENT_QUERY_TIMEOUT_GRACE_MS } from "../../utils/query-timeout.js";
import {
  READ_ONLY_OPEN,
  readOnlyFlagQuery,
  readOnlyClose,
  TIDB_OPEN,
  TIDB_CLOSE,
  VERSION_COMMENT_QUERY,
} from "../../utils/readonly-transaction.js";

// MySQL 8 has transaction_read_only; MariaDB has tx_read_only. The fake pool
// below answers the flag read with 0 (writable) unless a test says otherwise.
const READ_FLAG = readOnlyFlagQuery("transaction_read_only");
const READ_ONLY_COMMIT = readOnlyClose("transaction_read_only", "COMMIT", 0);
const READ_ONLY_ROLLBACK = readOnlyClose("transaction_read_only", "ROLLBACK", 0);
const MARIADB_READ_FLAG = readOnlyFlagQuery("tx_read_only");
const MARIADB_COMMIT = readOnlyClose("tx_read_only", "COMMIT", 0);

/**
 * Unit coverage for the readonly transaction strategy in the MySQL/MariaDB
 * connectors.
 *
 * The integration tests exercise the MySQL/MariaDB path against real containers,
 * but they cannot cover the TiDB branch (no TiDB container, and TiDB's behavior
 * is precisely that it *rejects* the statement the other engines accept). These
 * tests mock the driver so both branches are asserted at the statement level:
 *
 *   MySQL/MariaDB -> read flag; SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY
 *                    ... COMMIT; SET SESSION <flag> = <value read>
 *   TiDB          -> START TRANSACTION ... ROLLBACK   (writes discarded)
 *
 * The session-level READ ONLY is what stops DDL, which commits implicitly and
 * would otherwise escape the transaction; the flag is restored to the value the
 * connection had, not cleared, because the pooled connection is shared with
 * writable tools and its own default may be read-only too.
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
// Doris reports a stock-looking VERSION(); only @@version_comment gives it away.
const DORIS_VERSION = "5.7.99";
const DORIS_VERSION_COMMENT = "Doris version doris-4.0.8-rc01-1234abcd";

/**
 * Records every statement issued on the dedicated connection. `failOn` lets a
 * test make a specific statement throw instead of returning rows.
 */
function makeFakePool(
  version: string,
  wrapResults: (rows: any[]) => any,
  failOn?: (sql: string) => Error | undefined,
  /** What the server reports for @@session.<flag> before the guard is raised. */
  flag: unknown = 0,
  /** What the connect-time @@version_comment probe answers; an Error makes it fail. */
  versionComment: string | Error = "MySQL Community Server - GPL"
) {
  const statements: string[] = [];
  const conn = {
    threadId: 42,
    query: vi.fn(async (arg: any) => {
      const sql = typeof arg === "string" ? arg : arg.sql;
      statements.push(sql);
      const failure = failOn?.(sql);
      if (failure) throw failure;
      const results = wrapResults(sql.startsWith("SELECT @@session.") ? [{ ro: flag }] : [{ id: 1 }]);
      // mariadb answers a `metaAsArray` query with [rows, meta].
      return typeof arg === "object" && arg.metaAsArray ? [results, []] : results;
    }),
    release: vi.fn(),
    destroy: vi.fn(),
  };
  const pool = {
    // Connect-time flavor probe.
    query: vi.fn(async (sql: string) => {
      if (sql === VERSION_COMMENT_QUERY) {
        if (versionComment instanceof Error) throw versionComment;
        return wrapResults([{ version_comment: versionComment }]);
      }
      return wrapResults([{ version }]);
    }),
    getConnection: vi.fn(async () => conn),
    end: vi.fn(),
    // Connectors attach a pool 'error' listener at connect time.
    on: vi.fn(),
  };
  return { pool, conn, statements };
}

// mysql2 returns [rows, fields]; mariadb returns rows directly (except for a
// metaAsArray query, handled in makeFakePool).
const asMysql = (rows: any[]) => [rows, []];
const asMariadb = (rows: any[]) => rows;

async function connectMysql(pool: any, config?: { queryTimeoutSeconds?: number }) {
  mysqlCreatePool.mockReturnValue(pool);
  const connector = new MySQLConnector();
  await connector.connect("mysql://user:pass@localhost:3306/db", undefined, config);
  return connector;
}

async function connectMariadb(pool: any, config?: { queryTimeoutSeconds?: number }) {
  mariadbCreatePool.mockReturnValue(pool);
  const connector = new MariaDBConnector();
  await connector.connect("mariadb://user:pass@localhost:3306/db", undefined, config);
  return connector;
}

describe("readonly transaction strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("MySQL connector", () => {
    it("sets the session READ ONLY around a READ ONLY transaction on stock MySQL", async () => {
      const { pool, statements } = makeFakePool(MYSQL_VERSION, asMysql);
      const connector = await connectMysql(pool);
      await connector.executeSQL("SELECT 1", { readonly: true });

      // Read the flag, raise it with the transaction, run, commit and restore:
      // three round trips beyond the query.
      expect(statements).toEqual([READ_FLAG, READ_ONLY_OPEN, "SELECT 1", READ_ONLY_COMMIT]);
      expect(statements.join("\n")).not.toContain("READ WRITE");
    });

    it("restores a read-only default it found rather than clearing it", async () => {
      // The connection already defaulted to read-only (global default,
      // init_connect, or [sources.session]). The value DBHub read is what goes
      // back, as a literal: nothing the executed SQL does can change it.
      const { pool, statements } = makeFakePool(MYSQL_VERSION, asMysql, undefined, 1);
      const connector = await connectMysql(pool);
      await connector.executeSQL("SELECT @dbhub_tx_read_only := 0", { readonly: true });

      expect(statements[statements.length - 1]).toBe(
        readOnlyClose("transaction_read_only", "COMMIT", 1)
      );
    });

    // (A default-parameter fake cannot pass `undefined`; a missing column is
    // covered by the failed-read case below.)
    it.each([null, "", "   ", 2, "01", true, {}])(
      "refuses to proceed when the flag reads as %j",
      async (raw) => {
        // Only an exact 0 or 1 will do: coercion would turn null or a blank
        // string into 0 and later restore the session as writable.
        const { pool, conn, statements } = makeFakePool(MYSQL_VERSION, asMysql, undefined, raw);
        const connector = await connectMysql(pool);

        await expect(connector.executeSQL("SELECT 1", { readonly: true })).rejects.toThrow(
          "Could not read @@session.transaction_read_only"
        );
        expect(statements).toEqual([READ_FLAG, TIDB_CLOSE]);
        expect(conn.release).toHaveBeenCalled();
      }
    );

    it.each([
      ["the string '1'", "1", 1],
      ["the bigint 1n", 1n, 1],
      ["the string '0'", "0", 0],
    ])("accepts the flag as %s from drivers that return strings or bigints", async (_label, raw, saved) => {
      const { pool, statements } = makeFakePool(MYSQL_VERSION, asMysql, undefined, raw);
      const connector = await connectMysql(pool);
      await connector.executeSQL("SELECT 1", { readonly: true });

      expect(statements[statements.length - 1]).toBe(
        readOnlyClose("transaction_read_only", "COMMIT", saved as 0 | 1)
      );
    });

    it("refuses to proceed when the flag cannot be read", async () => {
      const { pool, conn, statements } = makeFakePool(MYSQL_VERSION, asMysql, (sql) =>
        sql === READ_FLAG ? new Error("server gone") : undefined
      );
      const connector = await connectMysql(pool);

      await expect(connector.executeSQL("SELECT 1", { readonly: true })).rejects.toThrow(
        "server gone"
      );
      // Nothing was raised, so nothing is restored; the query never ran.
      expect(statements).toEqual([READ_FLAG, TIDB_CLOSE]);
      expect(conn.release).toHaveBeenCalled();
    });

    it("uses tx_read_only on MySQL before 5.7.20", async () => {
      const { pool, statements } = makeFakePool("5.7.19-log", asMysql);
      const connector = await connectMysql(pool);
      await connector.executeSQL("SELECT 1", { readonly: true });

      expect(statements[0]).toBe(readOnlyFlagQuery("tx_read_only"));
      expect(statements[3]).toBe(readOnlyClose("tx_read_only", "COMMIT", 0));
    });

    it("falls back to a plain transaction + ROLLBACK on TiDB", async () => {
      const { pool, statements } = makeFakePool(TIDB_VERSION, asMysql);
      const connector = await connectMysql(pool);
      await connector.executeSQL("SELECT 1", { readonly: true });

      // TiDB rejects the READ ONLY modifier, so it must never be sent...
      expect(statements.join("\n")).not.toContain("READ ONLY");
      expect(statements[0]).toBe(TIDB_OPEN);
      // ...and the transaction is discarded so any missed DML never persists.
      expect(statements[statements.length - 1]).toBe(TIDB_CLOSE);
    });

    it("runs unwrapped on Apache Doris, which has no transaction a query can run in", async () => {
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { pool, statements } = makeFakePool(
          DORIS_VERSION,
          asMysql,
          undefined,
          0,
          DORIS_VERSION_COMMENT
        );
        const connector = await connectMysql(pool);
        await connector.executeSQL("SELECT 1 AS connection_ok", { readonly: true });

        // No flag read, no SET SESSION, no START TRANSACTION, no COMMIT/ROLLBACK.
        expect(statements).toEqual(["SELECT 1 AS connection_ok"]);
        // The weaker guarantee is announced once, at connect time.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("Apache Doris detected");
      } finally {
        warn.mockRestore();
      }
    });

    it("keeps the READ ONLY backstop when @@version_comment cannot be read", async () => {
      // A server without the variable still connects, and fails closed: the
      // stock-looking version alone is never enough to drop the backstop.
      const { pool, statements } = makeFakePool(
        DORIS_VERSION,
        asMysql,
        undefined,
        0,
        new Error("Unknown system variable 'version_comment'")
      );
      const connector = await connectMysql(pool);
      await connector.executeSQL("SELECT 1", { readonly: true });

      expect(statements).toEqual([READ_FLAG, READ_ONLY_OPEN, "SELECT 1", READ_ONLY_COMMIT]);
    });

    it("opens no transaction when readonly is off", async () => {
      const { pool, statements } = makeFakePool(TIDB_VERSION, asMysql);
      const connector = await connectMysql(pool);
      await connector.executeSQL("SELECT 1", {});

      expect(statements).toEqual(["SELECT 1"]);
    });
  });

  describe("error handling", () => {
    it("rolls back and rethrows when the query fails", async () => {
      const { pool, conn, statements } = makeFakePool(MYSQL_VERSION, asMysql, (sql) =>
        sql === "SELECT bad" ? new Error("syntax error") : undefined
      );
      const connector = await connectMysql(pool);

      await expect(connector.executeSQL("SELECT bad", { readonly: true })).rejects.toThrow(
        "syntax error"
      );

      // The open transaction must be rolled back and the session flag restored
      // so the pooled connection is returned clean, and the original error
      // must survive.
      expect(statements[1]).toBe(READ_ONLY_OPEN);
      expect(statements[statements.length - 1]).toBe(READ_ONLY_ROLLBACK);
      expect(conn.release).toHaveBeenCalled();
    });

    it("attempts a rollback when the guard fails to open", async () => {
      const { pool, conn, statements } = makeFakePool(MYSQL_VERSION, asMysql, (sql) =>
        sql === READ_ONLY_OPEN ? new Error("server gone") : undefined
      );
      const connector = await connectMysql(pool);

      await expect(connector.executeSQL("SELECT 1", { readonly: true })).rejects.toThrow(
        "server gone"
      );

      // A partially-opened guard must still be rolled back and reset, or the
      // connection returns to the pool with an open transaction or a read-only
      // session.
      expect(statements).toContain(READ_ONLY_ROLLBACK);
      // The query itself must never run once the read-only guard failed to open.
      expect(statements).not.toContain("SELECT 1");
      expect(conn.release).toHaveBeenCalled();
    });

    it("surfaces the original error even if the rollback also fails", async () => {
      const { pool, conn } = makeFakePool(MYSQL_VERSION, asMysql, (sql) => {
        if (sql === "SELECT bad") return new Error("syntax error");
        if (sql === READ_ONLY_ROLLBACK) return new Error("connection lost");
        return undefined;
      });
      const connector = await connectMysql(pool);

      // The rollback failure must not mask the more useful original error.
      await expect(connector.executeSQL("SELECT bad", { readonly: true })).rejects.toThrow(
        "syntax error"
      );
      expect(conn.release).toHaveBeenCalled();
    });

    it("kills the query and destroys the connection on a client-side timeout, skipping rollback", async () => {
      const timeoutError = Object.assign(new Error("Query inactivity timeout"), {
        code: "PROTOCOL_SEQUENCE_TIMEOUT",
      });
      const { pool, conn, statements } = makeFakePool(MYSQL_VERSION, asMysql, (sql) =>
        sql === "SELECT SLEEP(8)" ? timeoutError : undefined
      );

      // First getConnection() returns the dedicated connection used for the
      // query; the connector must request a second, separate connection to
      // issue KILL QUERY, since `conn`'s own command queue is stuck.
      const killerConn = {
        query: vi.fn(async () => asMysql([])),
        release: vi.fn(),
        destroy: vi.fn(),
      };
      pool.getConnection = vi
        .fn()
        .mockResolvedValueOnce(conn)
        .mockResolvedValueOnce(killerConn);
      const connector = await connectMysql(pool);

      await expect(
        connector.executeSQL("SELECT SLEEP(8)", { readonly: true })
      ).rejects.toThrow("Query inactivity timeout");

      // The connection's command queue is stuck behind the abandoned query,
      // so attempting ROLLBACK on it would hang until the server-side
      // statement eventually finishes.
      expect(statements.join("\n")).not.toContain("ROLLBACK");
      // The server-side statement is killed over the fresh connection, bounded
      // by its own short timeout independent of the user's query_timeout...
      expect(killerConn.query).toHaveBeenCalledWith(
        expect.objectContaining({ sql: `KILL QUERY ${conn.threadId}` })
      );
      expect(killerConn.release).toHaveBeenCalled();
      expect(killerConn.destroy).not.toHaveBeenCalled();
      // ...and the poisoned connection is destroyed, never returned to the pool.
      expect(conn.destroy).toHaveBeenCalled();
      expect(conn.release).not.toHaveBeenCalled();
      // It is destroyed before the kill, so its pool slot is free for the
      // connection the kill needs.
      expect(conn.destroy.mock.invocationCallOrder[0]).toBeLessThan(
        pool.getConnection.mock.invocationCallOrder[1]
      );
    });
  });

  describe("MySQL query_timeout", () => {
    it("sets max_execution_time on every new pool connection", async () => {
      const { pool } = makeFakePool(MYSQL_VERSION, asMysql);
      await connectMysql(pool, { queryTimeoutSeconds: 30 });

      const listener = pool.on.mock.calls.find(([event]) => event === "connection")?.[1];
      expect(listener).toBeTypeOf("function");

      // mysql2 hands the listener its callback-style connection.
      const rawConnection = { query: vi.fn() };
      listener(rawConnection);
      expect(rawConnection.query).toHaveBeenCalledWith(
        "SET SESSION max_execution_time = 30000",
        expect.any(Function)
      );
      // A server that rejects the variable must not break the connection.
      const callback = rawConnection.query.mock.calls[0][1];
      expect(() => callback(new Error("Unknown system variable 'max_execution_time'"))).not.toThrow();
    });

    it("leaves the session alone when query_timeout is not configured", async () => {
      const { pool } = makeFakePool(MYSQL_VERSION, asMysql);
      await connectMysql(pool);

      expect(pool.on.mock.calls.some(([event]) => event === "connection")).toBe(false);
    });

    it("delays the client-side timeout by the grace period", async () => {
      const { pool, conn } = makeFakePool(MYSQL_VERSION, asMysql);
      const connector = await connectMysql(pool, { queryTimeoutSeconds: 30 });
      await connector.executeSQL("SELECT 1", {});

      expect(conn.query).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: "SELECT 1",
          timeout: 30_000 + CLIENT_QUERY_TIMEOUT_GRACE_MS,
        })
      );
    });
  });

  describe("MariaDB connector", () => {
    it("sets the session READ ONLY around a READ ONLY transaction on stock MariaDB", async () => {
      const { pool, statements } = makeFakePool(MARIADB_VERSION, asMariadb);
      const connector = await connectMariadb(pool);
      await connector.executeSQL("SELECT 1", { readonly: true });

      // MariaDB names the flag tx_read_only.
      expect(statements).toEqual([MARIADB_READ_FLAG, READ_ONLY_OPEN, "SELECT 1", MARIADB_COMMIT]);
    });

    it("falls back to a plain transaction + ROLLBACK on TiDB", async () => {
      const { pool, statements } = makeFakePool(TIDB_VERSION, asMariadb);
      const connector = await connectMariadb(pool);
      await connector.executeSQL("SELECT 1", { readonly: true });

      expect(statements.join("\n")).not.toContain("READ ONLY");
      expect(statements[0]).toBe(TIDB_OPEN);
      expect(statements[statements.length - 1]).toBe(TIDB_CLOSE);
    });

    it("runs unwrapped on Apache Doris", async () => {
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { pool, statements } = makeFakePool(
          DORIS_VERSION,
          asMariadb,
          undefined,
          0,
          DORIS_VERSION_COMMENT
        );
        const connector = await connectMariadb(pool);
        await connector.executeSQL("SELECT 1", { readonly: true });

        expect(statements).toEqual(["SELECT 1"]);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("MariaDB query_timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("passes the server-side limit to the driver", async () => {
      const { pool } = makeFakePool(MARIADB_VERSION, asMariadb);
      await connectMariadb(pool, { queryTimeoutSeconds: 30 });

      // The driver applies queryTimeout as max_statement_time on each connection.
      expect(mariadbCreatePool).toHaveBeenCalledWith(
        expect.objectContaining({ queryTimeout: 30_000 })
      );
    });

    it("abandons a statement the server did not stop and destroys the connection, skipping rollback", async () => {
      const { pool, conn, statements } = makeFakePool(MARIADB_VERSION, asMariadb);
      const connector = await connectMariadb(pool, { queryTimeoutSeconds: 30 });
      vi.useFakeTimers();

      // The statement never answers, as when max_statement_time was cleared
      // on the pooled connection.
      const answer = conn.query.getMockImplementation()!;
      conn.query.mockImplementation((arg: any) =>
        (typeof arg === "string" ? arg : arg.sql) === "SELECT SLEEP(600)"
          ? new Promise(() => {})
          : answer(arg)
      );

      const settled = connector
        .executeSQL("SELECT SLEEP(600)", { readonly: true })
        .catch((error) => error);

      // Still waiting right up to the grace period after the configured limit...
      await vi.advanceTimersByTimeAsync(30_000 + CLIENT_QUERY_TIMEOUT_GRACE_MS - 1);
      expect(conn.destroy).not.toHaveBeenCalled();
      // ...then the client-side fallback fires.
      await vi.advanceTimersByTimeAsync(1);

      const error = await settled;
      expect(error.code).toBe("DBHUB_CLIENT_QUERY_TIMEOUT");
      // The connection is still waiting on the abandoned statement, so a
      // ROLLBACK would queue behind it.
      expect(statements.join("\n")).not.toContain("ROLLBACK");
      // destroy() also kills the server-side thread (the driver does this
      // itself when a command is in flight); the connection never returns to
      // the pool.
      expect(conn.destroy).toHaveBeenCalled();
      expect(conn.release).not.toHaveBeenCalled();
    });

    it("applies no client-side deadline when query_timeout is not configured", async () => {
      const { pool, conn } = makeFakePool(MARIADB_VERSION, asMariadb);
      const connector = await connectMariadb(pool);
      vi.useFakeTimers();

      await connector.executeSQL("SELECT 1", {});

      expect(vi.getTimerCount()).toBe(0);
      expect(conn.release).toHaveBeenCalled();
    });
  });
});
