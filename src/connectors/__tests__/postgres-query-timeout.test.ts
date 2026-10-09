import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { CANCEL_QUERY_TIMEOUT_MS } from "../../utils/query-timeout.js";

/**
 * Unit coverage for the PostgreSQL client-side query timeout fallback.
 *
 * node-postgres's `query_timeout` only rejects the query's promise: the client
 * keeps waiting for the server's answer, so anything sent on it afterwards
 * queues behind the abandoned statement. The integration suite exercises the
 * fallback against a real server; these tests pin the order of operations.
 */

const BACKEND_PID = 4242;

/** The error node-postgres raises for its client-side timeout: no `code`. */
const clientTimeout = () => new Error("Query read timeout");

class FakePgPool extends EventEmitter {
  statements: string[] = [];
  failOn: (sql: string) => Error | undefined = () => undefined;
  client = {
    processID: BACKEND_PID,
    query: vi.fn(async (sql: string) => {
      this.statements.push(sql);
      const failure = this.failOn(sql);
      if (failure) throw failure;
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  connect = vi.fn(async () => this.client);
  query = vi.fn(async (_config: unknown) => ({ rows: [{ pg_cancel_backend: true }], rowCount: 1 }));
  end = vi.fn().mockResolvedValue(undefined);
}

let pool: FakePgPool;

vi.mock("pg", () => ({
  default: {
    Pool: function () {
      return pool;
    },
    types: { builtins: {}, getTypeParser: () => (value: string) => value },
  },
}));

const { PostgresConnector } = await import("../postgres/index.js");

async function connect() {
  const connector = new PostgresConnector();
  await connector.connect("postgres://u:p@localhost:5432/db", undefined, {
    queryTimeoutSeconds: 30,
  });
  // connect() checks out and releases a client to test the connection.
  pool.client.release.mockClear();
  pool.connect.mockClear();
  return connector;
}

describe("PostgreSQL client-side query timeout", () => {
  beforeEach(() => {
    pool = new FakePgPool();
  });

  it.each([
    ["a read-only statement", "SELECT pg_sleep(600)", { readonly: true }],
    ["a writable statement", "SELECT pg_sleep(600)", {}],
    ["a multi-statement batch", "SET statement_timeout = 0; SELECT pg_sleep(600)", {}],
  ])("discards the client and cancels the backend for %s, skipping rollback", async (_label, sql, options) => {
    pool.failOn = (statement) => (statement.includes("pg_sleep") ? clientTimeout() : undefined);
    const connector = await connect();

    await expect(connector.executeSQL(sql, options)).rejects.toThrow("Query read timeout");

    // The client is still waiting on the abandoned statement, so a ROLLBACK
    // would queue behind it.
    expect(pool.statements).not.toContain("ROLLBACK");
    // Released exactly once, with a truthy argument: pg-pool closes the socket
    // and drops the client instead of returning it to the pool.
    expect(pool.client.release).toHaveBeenCalledTimes(1);
    expect(pool.client.release).toHaveBeenCalledWith(true);
    // The statement is cancelled on the server over another pooled connection,
    // bounded by its own short timeout...
    expect(pool.query).toHaveBeenCalledWith({
      text: "SELECT pg_cancel_backend($1)",
      values: [BACKEND_PID],
      query_timeout: CANCEL_QUERY_TIMEOUT_MS,
    });
    // ...after the client was discarded, so the cancel can use its pool slot
    // (pool_max_connections = 1 would otherwise wait on itself).
    expect(pool.client.release.mock.invocationCallOrder[0]).toBeLessThan(
      pool.query.mock.invocationCallOrder[0]
    );
  });

  it("surfaces the timeout even if the cancel fails", async () => {
    pool.failOn = (statement) => (statement.includes("pg_sleep") ? clientTimeout() : undefined);
    pool.query.mockRejectedValue(new Error("connection refused"));
    const connector = await connect();

    await expect(connector.executeSQL("SELECT pg_sleep(600)", { readonly: true })).rejects.toThrow(
      "Query read timeout"
    );
    expect(pool.client.release).toHaveBeenCalledWith(true);
  });

  it("keeps the client for a server-side statement_timeout cancellation", async () => {
    const cancelled = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    pool.failOn = (statement) => (statement.includes("pg_sleep") ? cancelled : undefined);
    const connector = await connect();

    await expect(connector.executeSQL("SELECT pg_sleep(600)", { readonly: true })).rejects.toBe(
      cancelled
    );

    // The server ended the statement itself: the client is clean, so it is
    // rolled back and returned to the pool as usual, and nothing is cancelled.
    expect(pool.statements[pool.statements.length - 1]).toBe("ROLLBACK");
    expect(pool.client.release).toHaveBeenCalledTimes(1);
    expect(pool.client.release).toHaveBeenCalledWith();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
