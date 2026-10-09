/**
 * Shared `query_timeout` policy for the pooled server connectors (PostgreSQL,
 * MySQL, MariaDB).
 *
 * The configured limit is enforced by the database itself wherever the engine
 * can do it (PostgreSQL `statement_timeout`, MySQL `max_execution_time`,
 * MariaDB `max_statement_time`), so a timed-out statement stops running on the
 * server and the connection stays usable.
 *
 * A client-side deadline backs that up, because the server-side limit is a
 * session setting: it can be changed on the pooled connection, MySQL's only
 * covers read-only SELECTs, and no server setting helps when the network
 * stalls. The fallback fires CLIENT_QUERY_TIMEOUT_GRACE_MS after the
 * configured limit, so the server's own cancellation normally arrives first.
 * When the fallback does fire, every connector handles it the same way:
 *
 *   1. skip the ROLLBACK (the connection is still busy with the abandoned
 *      statement, so anything sent on it queues behind that statement),
 *   2. discard the connection instead of returning it to the pool,
 *   3. cancel the statement on the server over a separate connection.
 */

/** How long after `query_timeout` the client-side fallback fires. */
export const CLIENT_QUERY_TIMEOUT_GRACE_MS = 5_000;

/**
 * Bounds the cancellation statement sent after a client-side timeout. It is
 * independent of the user's (possibly long) `query_timeout`: cancelling is
 * metadata-only and returns almost immediately on a healthy server, so
 * cleanup must not stall when it does not.
 */
export const CANCEL_QUERY_TIMEOUT_MS = 5_000;

/** Largest delay Node's setTimeout honours; anything above it fires after 1ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Largest `query_timeout` (seconds) whose client-side deadline still fits a
 * Node timer. Enforced when the config is loaded; clientQueryTimeoutMs guards
 * the direct ConnectorConfig path.
 */
export const MAX_QUERY_TIMEOUT_SECONDS = Math.floor(
  (MAX_TIMER_MS - CLIENT_QUERY_TIMEOUT_GRACE_MS) / 1000
);

/**
 * Client-side deadline for a statement whose server-side limit is
 * `queryTimeoutMs`. Throws rather than schedule a deadline Node cannot
 * represent: setTimeout silently clamps NaN, Infinity and delays above
 * MAX_TIMER_MS to 1ms, which would abandon every statement immediately.
 */
export function clientQueryTimeoutMs(queryTimeoutMs: number): number {
  const deadlineMs = queryTimeoutMs + CLIENT_QUERY_TIMEOUT_GRACE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs > MAX_TIMER_MS) {
    throw new RangeError(
      `query_timeout of ${queryTimeoutMs}ms exceeds the client-side deadline range ` +
        `(at most ${MAX_QUERY_TIMEOUT_SECONDS} seconds)`
    );
  }
  return deadlineMs;
}

/** `code` of the error raised by withClientQueryDeadline. */
export const CLIENT_QUERY_TIMEOUT_CODE = "DBHUB_CLIENT_QUERY_TIMEOUT";

/** node-postgres reports its client-side `query_timeout` with this message and no code. */
const PG_CLIENT_TIMEOUT_MESSAGE = "Query read timeout";

/** mysql2 reports its client-side `timeout` with this code. */
const MYSQL2_CLIENT_TIMEOUT_CODE = "PROTOCOL_SEQUENCE_TIMEOUT";

/** Raised by withClientQueryDeadline when the deadline passes first. */
export class ClientQueryTimeoutError extends Error {
  readonly code = CLIENT_QUERY_TIMEOUT_CODE;

  constructor(timeoutMs: number) {
    super(`Query timed out on the client after ${timeoutMs}ms`);
    this.name = "ClientQueryTimeoutError";
  }
}

/**
 * True when a statement was abandoned by a client-side deadline rather than
 * ended by the server: mysql2's `timeout`, node-postgres's `query_timeout`, or
 * withClientQueryDeadline (MariaDB, whose driver has no client-side timer).
 *
 * In all three cases the driver only rejects the statement's promise. The
 * connection still considers that statement in flight, so anything sent on it
 * afterwards (a ROLLBACK included) queues behind the abandoned statement and
 * only runs once the server finally answers it, which silently turns a bounded
 * timeout into an unbounded hang. Callers must not reuse the connection.
 */
export function isClientSideTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === MYSQL2_CLIENT_TIMEOUT_CODE ||
    code === CLIENT_QUERY_TIMEOUT_CODE ||
    (code === undefined && message === PG_CLIENT_TIMEOUT_MESSAGE)
  );
}

/**
 * Reject with ClientQueryTimeoutError if `query` has not settled within
 * `timeoutMs`. With no timeout the promise is returned untouched.
 *
 * The abandoned promise is still pending when the deadline wins, and it
 * rejects later, once the caller discards the connection. That rejection is
 * swallowed here so it does not surface as an unhandled rejection.
 */
export function withClientQueryDeadline<T>(
  query: Promise<T>,
  timeoutMs: number | undefined
): Promise<T> {
  if (timeoutMs === undefined) {
    return query;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      query.catch(() => {});
      reject(new ClientQueryTimeoutError(timeoutMs));
    }, timeoutMs);
    query.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
