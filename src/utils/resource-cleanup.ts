/**
 * Helpers for tearing down half-built resources on a failed connect().
 */

/**
 * Run a close/teardown callback, swallowing any error it raises.
 *
 * Used on connect() failure paths: the connection error is the one worth
 * surfacing, and a teardown that also fails (e.g. closing a pool that never
 * finished opening) must not mask it. Without this, a pool created before a
 * failing probe is never closed — `ConnectorManager.connectSource` only
 * registers a connector *after* connect() resolves, so `disconnect()` never
 * sees it. Lazy sources retry on every tool call, so each failed attempt would
 * otherwise strand another pool holding sockets and timers.
 */
export async function closeQuietly(close: () => void | Promise<void>): Promise<void> {
  try {
    await close();
  } catch {
    // Ignore: the original connection error is the useful one.
  }
}
