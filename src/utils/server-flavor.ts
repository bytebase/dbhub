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
