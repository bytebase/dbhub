/**
 * Suppress the one-time `ExperimentalWarning` that Node.js emits the first time
 * the built-in `node:sqlite` module is loaded.
 *
 * Node emits this warning at module-load time, so the hook MUST be installed
 * before `node:sqlite` is loaded. The SQLite connector loads `node:sqlite`
 * lazily (dynamic import inside connect()), so call this immediately before
 * that import — that keeps the global `process.emitWarning` patch scoped to
 * processes that actually use SQLite, rather than installing it at startup for
 * every DBHub instance.
 *
 * Only this specific warning is filtered; all other process warnings pass
 * through unchanged. Idempotent — safe to call on every connect().
 */
let installed = false;

export function suppressSqliteExperimentalWarning(): void {
  if (installed) {
    return;
  }
  installed = true;

  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: any[]) => {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (message && message.includes("SQLite is an experimental feature")) {
      return;
    }
    return (originalEmitWarning as any)(warning, ...args);
  }) as typeof process.emitWarning;
}
