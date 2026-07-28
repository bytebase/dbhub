/**
 * Helpers for detecting MySQL-protocol server flavors that need behavior tweaks.
 */

/**
 * TiDB reports a MySQL-compatible version string that embeds its own version,
 * e.g. `8.0.11-TiDB-v7.5.0`. It matters because TiDB treats the `READ ONLY`
 * transaction modifier as a noop function and rejects it unless
 * `tidb_enable_noop_functions` is enabled, so the engine-level read-only
 * backstop has to take a different form there.
 */
export function isTiDBVersion(version: unknown): boolean {
  return typeof version === "string" && /tidb/i.test(version);
}

export type MySQLServerFlavor =
  | "mysql_5_7"
  | "mysql_8"
  | "mysql_9"
  | "tidb"
  | "unsupported_or_unknown";

const KNOWN_NON_COMMUNITY_MARKERS = /mariadb|percona|aurora|vitess|oceanbase|polardb|singlestore/i;

/**
 * Classify eligibility for the standard-MySQL hardened readonly path.
 *
 * TiDB must win before the generic 5.7/8.x/9.x prefixes because its compatibility
 * version begins with one of those values. Other known protocol-compatible
 * servers deliberately stay outside the new contract.
 */
export function detectMySQLServerFlavor(version: unknown): MySQLServerFlavor {
  if (isTiDBVersion(version)) {
    return "tidb";
  }
  if (typeof version !== "string" || KNOWN_NON_COMMUNITY_MARKERS.test(version)) {
    return "unsupported_or_unknown";
  }
  // Standard Community Server reports a bare semantic version. `-log` is the
  // documented server suffix when binary logging is enabled. Reject every
  // other suffix instead of guessing that an unknown compatible distribution
  // is standard MySQL.
  if (/^5\.7\.\d+(?:-log)?$/i.test(version)) {
    return "mysql_5_7";
  }
  if (/^8\.\d+\.\d+(?:-log)?$/i.test(version)) {
    return "mysql_8";
  }
  if (/^9\.\d+\.\d+(?:-log)?$/i.test(version)) {
    return "mysql_9";
  }
  return "unsupported_or_unknown";
}
