/**
 * Suppress the one-time `ExperimentalWarning` that Node.js emits the first time
 * the built-in `node:sqlite` module is loaded.
 *
 * Node emits this warning at module-load time, so this hook MUST be installed
 * before `node:sqlite` is imported anywhere in the process. Import this module
 * *before* the `node:sqlite` import (ESM evaluates imports in source order).
 *
 * Only this specific warning is filtered; all other process warnings pass
 * through unchanged.
 */
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: any[]) => {
  const message = typeof warning === "string" ? warning : warning?.message;
  if (message && message.includes("SQLite is an experimental feature")) {
    return;
  }
  return (originalEmitWarning as any)(warning, ...args);
}) as typeof process.emitWarning;
