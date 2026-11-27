import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import type mysql from "mysql2/promise";
import {
  MySQLConnector,
  parseConnectionId,
  resolveServerThreadId,
  trackServerThreadIds,
} from "../mysql/index.js";

describe("parseConnectionId", () => {
  it("extracts positive safe integers from number, string, and bigint values", () => {
    expect(parseConnectionId([{ id: 29 }])).toBe(29);
    expect(parseConnectionId([{ id: "42" }])).toBe(42);
    expect(parseConnectionId([{ id: " 108 " }])).toBe(108);
    expect(parseConnectionId([{ id: 999n }])).toBe(999);
  });

  it("returns undefined for empty, malformed, zero, negative, or unsafe values", () => {
    expect(parseConnectionId([])).toBeUndefined();
    expect(parseConnectionId(null)).toBeUndefined();
    expect(parseConnectionId([{}])).toBeUndefined();
    expect(parseConnectionId([{ id: 0 }])).toBeUndefined();
    expect(parseConnectionId([{ id: -5 }])).toBeUndefined();
    expect(parseConnectionId([{ id: 1.5 }])).toBeUndefined();
    expect(parseConnectionId([{ id: "29; DROP TABLE users" }])).toBeUndefined();
    expect(parseConnectionId([{ id: Number.MAX_SAFE_INTEGER + 1 }])).toBeUndefined();
  });
});

describe("trackServerThreadIds & resolveServerThreadId", () => {
  it("records the backend CONNECTION_ID() on the underlying raw connection and prefers it over proxy threadId", () => {
    const pool = new EventEmitter();
    const serverThreadIds = new WeakMap<object, number>();
    trackServerThreadIds(pool as unknown as mysql.Pool, serverThreadIds);

    const rawConn = {
      threadId: 40001, // synthetic id from a handshake-terminating proxy
      query: vi.fn((sql: string, cb: (err: unknown, rows?: unknown) => void) => {
        expect(sql).toBe("SELECT CONNECTION_ID() AS id");
        cb(null, [{ id: 29 }]);
      }),
    };

    pool.emit("connection", rawConn);

    // mysql2/promise wraps the raw PoolConnection on `.connection`
    const promiseConn = {
      connection: rawConn,
      threadId: 40001,
    } as unknown as mysql.PoolConnection;

    expect(resolveServerThreadId(promiseConn, serverThreadIds, 40001)).toBe(29);
  });

  it("falls back to conn.threadId when SELECT CONNECTION_ID() fails", () => {
    const pool = new EventEmitter();
    const serverThreadIds = new WeakMap<object, number>();
    trackServerThreadIds(pool as unknown as mysql.Pool, serverThreadIds);

    const rawConn = {
      threadId: 77,
      query: vi.fn((_sql: string, cb: (err: unknown, rows?: unknown) => void) => {
        cb(new Error("permission denied"));
      }),
    };

    pool.emit("connection", rawConn);

    const promiseConn = {
      connection: rawConn,
      threadId: 77,
    } as unknown as mysql.PoolConnection;

    expect(resolveServerThreadId(promiseConn, serverThreadIds, 77)).toBe(77);
  });

  it("uses the real backend thread id in KILL QUERY when executeSQL hits a client-side timeout", async () => {
    const pool = new EventEmitter();
    const serverThreadIds = new WeakMap<object, number>();
    trackServerThreadIds(pool as unknown as mysql.Pool, serverThreadIds);

    // Simulate a pipelined SELECT CONNECTION_ID() callback that completes
    // before the slow query times out.
    let resolveConnectionId: (() => void) | undefined;
    const rawConn = {
      threadId: 40001,
      query: vi.fn((_sql: string, cb: (err: unknown, rows?: unknown) => void) => {
        resolveConnectionId = () => cb(null, [{ id: 29 }]);
      }),
    };
    pool.emit("connection", rawConn);

    const timeoutError = Object.assign(new Error("Query inactivity timeout"), {
      code: "PROTOCOL_SEQUENCE_TIMEOUT",
    });

    const queryConn = {
      connection: rawConn,
      threadId: 40001,
      query: vi.fn(async () => {
        // FIFO guarantee: CONNECTION_ID() finishes before the user query times out
        resolveConnectionId?.();
        throw timeoutError;
      }),
      destroy: vi.fn(),
      release: vi.fn(),
    };

    const killerConn = {
      query: vi.fn(async () => [[]]),
      destroy: vi.fn(),
      release: vi.fn(),
    };

    const getConnection = vi
      .fn()
      .mockResolvedValueOnce(queryConn)
      .mockResolvedValueOnce(killerConn);

    const connector = new MySQLConnector();
    (connector as unknown as { pool: unknown }).pool = Object.assign(pool, { getConnection });
    (connector as unknown as { serverThreadIds: WeakMap<object, number> }).serverThreadIds =
      serverThreadIds;
    (connector as unknown as { clientQueryTimeoutMs: number }).clientQueryTimeoutMs = 5000;

    await expect(connector.executeSQL("SELECT SLEEP(30)", {})).rejects.toThrow(
      "Query inactivity timeout"
    );

    expect(queryConn.destroy).toHaveBeenCalledTimes(1);
    expect(queryConn.release).not.toHaveBeenCalled();
    expect(killerConn.query).toHaveBeenCalledWith(
      expect.objectContaining({ sql: "KILL QUERY 29" })
    );
    expect(killerConn.release).toHaveBeenCalledTimes(1);
  });
});
