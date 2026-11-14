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

/**
 * Apache Doris speaks the MySQL protocol and reports a stock-looking version
 * (`5.7.99`), so `VERSION()` cannot identify it. `@@version_comment` can, e.g.
 * `Doris version doris-4.0.8-rc01-1234abcd`. It matters because Doris rejects
 * `START TRANSACTION READ ONLY` and does not run queries inside an explicit
 * transaction at all, so no transaction-based read-only backstop applies there.
 */
export function isDorisVersionComment(versionComment: unknown): boolean {
  return typeof versionComment === "string" && /^\s*doris\b/i.test(versionComment);
}
