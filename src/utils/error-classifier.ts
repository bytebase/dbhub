import type { ConnectorType } from "../connectors/interface.js";

/**
 * Distinct error codes for connection/access failures, so an MCP client can
 * tell "the source is down / mis-credentialed" (restore access) from "your
 * query is wrong" (fix the SQL). Anything not matched here is left to the
 * caller's existing generic error path.
 */
export type ConnectionErrorCode = "SOURCE_UNREACHABLE" | "AUTH_FAILED" | "TUNNEL_FAILED";

/**
 * Property set on errors thrown while establishing an SSH tunnel, so the
 * classifier can distinguish TUNNEL_FAILED from a plain network failure
 * without parsing message text. Set in ConnectorManager.connectSource.
 */
export const TUNNEL_ERROR_MARKER = "__dbhubSSHTunnelError";

// Node socket-level codes that mean "could not reach / lost the source".
// Timeout (ETIMEDOUT) is folded in here: refused vs timed-out differ at the
// TCP level but call for the same remediation.
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
]);

// Per-connector authentication failure signals. Keyed by code or errno.
const AUTH_CODES: Record<ConnectorType, ReadonlyArray<string | number>> = {
  postgres: ["28P01", "28000"],
  mysql: ["ER_ACCESS_DENIED_ERROR", 1045, 1698],
  mariadb: ["ER_ACCESS_DENIED_ERROR", 1045, 1698],
  sqlserver: ["ELOGIN"],
  sqlite: [], // no network/auth layer
};

function unreachableMessage(sourceId: string): string {
  return `Source '${sourceId}' is unreachable. ` +
    `Verify the database is running and reachable (host, port, network), then retry.`;
}

function authMessage(sourceId: string): string {
  return `Authentication failed for source '${sourceId}'. ` +
    `Verify the credentials/access for this source are valid, then retry.`;
}

function tunnelMessage(sourceId: string): string {
  return `SSH tunnel for source '${sourceId}' failed to establish. ` +
    `Verify SSH host/credentials and bastion reachability, then retry.`;
}

/**
 * Classify a thrown error from a connect attempt or query into a connection
 * failure category. Returns null when the error is not a recognized
 * connection/access failure (caller should fall back to its generic handling).
 * Pure; never throws.
 */
export function classifyConnectionError(
  error: unknown,
  connectorType: ConnectorType,
  sourceId: string
): { code: ConnectionErrorCode; message: string } | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const err = error as Record<string, unknown>;

  // Tunnel marker wins over the underlying network code.
  if (err[TUNNEL_ERROR_MARKER] === true) {
    return { code: "TUNNEL_FAILED", message: tunnelMessage(sourceId) };
  }

  const code = err.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return { code: "SOURCE_UNREACHABLE", message: unreachableMessage(sourceId) };
  }

  const authCodes = AUTH_CODES[connectorType];
  const errno = err.errno;
  if (
    (typeof code === "string" && authCodes.includes(code)) ||
    (typeof errno === "number" && authCodes.includes(errno))
  ) {
    return { code: "AUTH_FAILED", message: authMessage(sourceId) };
  }

  return null;
}
