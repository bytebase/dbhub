import type http from "http";

/**
 * Idle keep-alive timeout for the HTTP transport, in milliseconds.
 *
 * Node's default is 5s. Reverse proxies and load balancers that pool
 * upstream connections hold them idle for longer than that (AWS ALB and
 * API Gateway VPC links default to 60s, as does nginx `keepalive`). When the
 * proxy writes a request into a socket that Node is closing at the same
 * moment, the proxy answers the client with its own 502/503 and the request
 * never reaches DBHub (issue #472).
 *
 * The backend's idle timeout must be longer than the proxy's so the proxy is
 * always the side that closes an idle connection. 65s is the widely used
 * value for 60s proxies.
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * Headers timeout for the HTTP transport, in milliseconds.
 *
 * Node requires this to be strictly greater than `keepAliveTimeout`;
 * otherwise a reused socket can be closed while a request's headers are
 * still arriving.
 */
export const HTTP_HEADERS_TIMEOUT_MS = HTTP_KEEP_ALIVE_TIMEOUT_MS + 1_000;

/**
 * Apply keep-alive timeouts that survive a 60s proxy idle timeout.
 */
export function configureHttpKeepAlive(server: http.Server): void {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
}
