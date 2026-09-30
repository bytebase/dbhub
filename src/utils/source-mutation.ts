/**
 * Shared state for runtime source changes: which source ids came from the
 * startup configuration (immutable over the API), and a lock so a TOML reload
 * and an API call never interleave their per-source add/remove steps.
 */

const fileSourceIds = new Set<string>();
let chain: Promise<unknown> = Promise.resolve();

/** Record the ids the startup configuration (TOML / --dsn / demo) defines. */
export function setFileSourceIds(ids: Iterable<string>): void {
  fileSourceIds.clear();
  for (const id of ids) {
    fileSourceIds.add(id);
  }
}

/** Whether a source id is owned by the startup configuration. */
export function isFileSource(id: string): boolean {
  return fileSourceIds.has(id);
}

/** Run `fn` after every previously queued mutation has settled. */
export function withSourceLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
