import { describe, it, expect, vi, afterEach } from "vitest";
import type mysql from "mysql2/promise";
import { getConnectionWithin } from "../mysql/index.js";

/**
 * Unit coverage for the bounded wait on a free MySQL pool connection. mysql2
 * queues a getConnection() beyond connectionLimit with no time limit; the
 * integration suite checks the behaviour against a real server, and these
 * tests pin what happens to a connection handed out after the caller gave up.
 */

function fakePool() {
  let hand: (conn: mysql.PoolConnection) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const pool = {
    getConnection: vi.fn(
      () =>
        new Promise<mysql.PoolConnection>((resolve, reject) => {
          hand = resolve;
          fail = reject;
        })
    ),
  };
  return {
    pool: pool as unknown as mysql.Pool,
    hand: (conn: mysql.PoolConnection) => hand(conn),
    fail: (err: Error) => fail(err),
  };
}

const fakeConnection = () => ({ release: vi.fn() }) as unknown as mysql.PoolConnection & { release: ReturnType<typeof vi.fn> };

describe("getConnectionWithin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should return a connection handed out within the limit", async () => {
    const { pool, hand } = fakePool();
    const conn = fakeConnection();

    const acquired = getConnectionWithin(pool, 1000);
    hand(conn);

    await expect(acquired).resolves.toBe(conn);
    expect(conn.release).not.toHaveBeenCalled();
  });

  it("should reject once the limit passes and release the connection handed out later", async () => {
    vi.useFakeTimers();
    const { pool, hand } = fakePool();
    const conn = fakeConnection();

    const acquired = getConnectionWithin(pool, 1000);
    const settled = expect(acquired).rejects.toThrow(
      "Timed out after 1000 ms waiting for a free connection from the pool"
    );
    await vi.advanceTimersByTimeAsync(1000);
    await settled;

    // The request is still queued in the pool; its connection must go back.
    hand(conn);
    await vi.runAllTimersAsync();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it("should ignore a pool error after the limit has passed", async () => {
    vi.useFakeTimers();
    const { pool, fail } = fakePool();

    const acquired = getConnectionWithin(pool, 1000);
    const settled = expect(acquired).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await settled;

    // e.g. the pool is closed while the request is still queued
    fail(new Error("Pool is closed."));
    await vi.runAllTimersAsync();
  });

  it("should wait without a limit when none is configured", async () => {
    vi.useFakeTimers();
    const { pool, hand } = fakePool();
    const conn = fakeConnection();

    const acquired = getConnectionWithin(pool, undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    hand(conn);

    await expect(acquired).resolves.toBe(conn);
  });
});
