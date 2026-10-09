/**
 * Helpers shared by the connector integration tests that exercise
 * `query_timeout` against a real server.
 */

/** Poll `predicate` until it holds or `timeoutMs` passes. */
export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** Settle `promise` and report how long it took, without throwing. */
export async function settle<T>(
  promise: Promise<T>
): Promise<{ elapsedMs: number; value?: T; error?: any }> {
  const started = Date.now();
  try {
    const value = await promise;
    return { elapsedMs: Date.now() - started, value };
  } catch (error) {
    return { elapsedMs: Date.now() - started, error };
  }
}
