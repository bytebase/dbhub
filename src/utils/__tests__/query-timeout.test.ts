import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CLIENT_QUERY_TIMEOUT_CODE,
  CLIENT_QUERY_TIMEOUT_GRACE_MS,
  ClientQueryTimeoutError,
  MAX_QUERY_TIMEOUT_SECONDS,
  clientQueryTimeoutMs,
  isClientSideTimeout,
  withClientQueryDeadline,
} from "../query-timeout.js";

describe("clientQueryTimeoutMs", () => {
  it("trails the server-side limit by the grace period", () => {
    expect(clientQueryTimeoutMs(30_000)).toBe(30_000 + CLIENT_QUERY_TIMEOUT_GRACE_MS);
  });

  it("accepts the largest limit the config loader allows", () => {
    expect(clientQueryTimeoutMs(MAX_QUERY_TIMEOUT_SECONDS * 1000)).toBeLessThanOrEqual(2_147_483_647);
  });

  // setTimeout clamps these to 1ms, so a deadline built from them would
  // abandon every statement immediately instead of after query_timeout.
  it.each([
    ["Infinity", Infinity],
    ["NaN", NaN],
    ["beyond Node's timer range", (MAX_QUERY_TIMEOUT_SECONDS + 1) * 1000],
  ])("rejects a limit of %s instead of scheduling an unrepresentable deadline", (_label, ms) => {
    expect(() => clientQueryTimeoutMs(ms)).toThrow(RangeError);
  });
});

describe("isClientSideTimeout", () => {
  it.each([
    ["mysql2", Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" })],
    ["node-postgres", new Error("Query read timeout")],
    ["withClientQueryDeadline", new ClientQueryTimeoutError(1000)],
  ])("recognizes the %s client-side timeout", (_driver, error) => {
    expect(isClientSideTimeout(error)).toBe(true);
  });

  it.each([
    ["a PostgreSQL statement_timeout cancellation", Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })],
    ["a MySQL max_execution_time interruption", Object.assign(new Error("Query execution was interrupted"), { code: "ER_QUERY_TIMEOUT", errno: 3024 })],
    ["a MariaDB max_statement_time interruption", Object.assign(new Error("Query execution was interrupted"), { code: "ER_STATEMENT_TIMEOUT", errno: 1969 })],
    ["a server error that reuses the node-postgres message", Object.assign(new Error("Query read timeout"), { code: "XX000" })],
    ["an ordinary error", new Error("syntax error")],
    ["a non-error value", "Query read timeout"],
    ["null", null],
  ])("does not treat %s as a client-side timeout", (_label, error) => {
    expect(isClientSideTimeout(error)).toBe(false);
  });
});

describe("withClientQueryDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the query untouched when no timeout is configured", () => {
    const query = Promise.resolve(1);
    expect(withClientQueryDeadline(query, undefined)).toBe(query);
  });

  it("resolves with the query's value when it settles first", async () => {
    vi.useFakeTimers();
    const result = withClientQueryDeadline(Promise.resolve("rows"), 1000);
    await expect(result).resolves.toBe("rows");
    // The timer was cleared, so nothing is left to fire.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the query's own error when it fails first", async () => {
    vi.useFakeTimers();
    const failure = new Error("syntax error");
    await expect(withClientQueryDeadline(Promise.reject(failure), 1000)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a client-side timeout once the deadline passes", async () => {
    vi.useFakeTimers();
    const result = withClientQueryDeadline(new Promise(() => {}), 1000);
    const settled = result.catch((error) => error);

    await vi.advanceTimersByTimeAsync(999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const error = (await settled) as ClientQueryTimeoutError;
    expect(error).toBeInstanceOf(ClientQueryTimeoutError);
    expect(error.code).toBe(CLIENT_QUERY_TIMEOUT_CODE);
    expect(isClientSideTimeout(error)).toBe(true);
  });

  it("swallows the abandoned query's later rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectQuery!: (error: Error) => void;
      const query = new Promise<never>((_resolve, reject) => {
        rejectQuery = reject;
      });
      const settled = withClientQueryDeadline(query, 1000).catch((error) => error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await settled).toBeInstanceOf(ClientQueryTimeoutError);

      // The driver rejects the abandoned statement when its connection is destroyed.
      rejectQuery(new Error("Connection destroyed, command was killed"));
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
