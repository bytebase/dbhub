/**
 * SQLite DSN path handling.
 *
 * A SQLite DSN carries nothing but a file path, so it is read as
 * `sqlite://<path>` rather than as a URL: there is no host, and splitting one
 * off (as a generic URL parser does) drops the first path segment of a
 * relative path.
 *
 * Accepted forms:
 *
 *   sqlite:///abs/path.db      absolute path  /abs/path.db
 *   sqlite:////abs/path.db     absolute path  /abs/path.db
 *   sqlite:///C:/path.db       Windows absolute path  C:/path.db
 *   sqlite:///./rel/path.db    relative path  ./rel/path.db
 *   sqlite://./rel/path.db     relative path  ./rel/path.db
 *   sqlite://rel/path.db       relative path  rel/path.db
 *   sqlite:///~/path.db        path under the home directory
 *   sqlite:///:memory:         in-memory database
 *
 * After three slashes a path is absolute unless it starts with `./`, `../` or
 * `~/`: `sqlite:///data.db` is `/data.db`, as it always has been.
 */

import { homedir } from "os";
import path from "path";

export const SQLITE_DSN_PREFIX = "sqlite://";
export const SQLITE_MEMORY_PATH = ":memory:";

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const EXPLICITLY_RELATIVE_PATH = /^(\.\.?|~)([\\/]|$)/;

/** Split a SQLite DSN into its path part and its query string (with the `?`). */
function splitQuery(dsn: string): { body: string; query: string } {
  const queryStart = dsn.indexOf("?");
  return queryStart === -1
    ? { body: dsn, query: "" }
    : { body: dsn.substring(0, queryStart), query: dsn.substring(queryStart) };
}

/**
 * Extract the database path from a SQLite DSN exactly as it was written:
 * `:memory:`, an absolute path, or a relative / `~/` path that still needs
 * resolving (see resolveSqliteFilePath).
 *
 * @throws if the DSN is not a SQLite DSN or names no path
 */
export function parseSqliteDsnPath(dsn: string): string {
  if (!dsn.startsWith(SQLITE_DSN_PREFIX)) {
    throw new Error(`not a SQLite DSN (expected it to start with "${SQLITE_DSN_PREFIX}")`);
  }

  const rest = splitQuery(dsn).body.substring(SQLITE_DSN_PREFIX.length);
  if (rest === SQLITE_MEMORY_PATH || rest === `/${SQLITE_MEMORY_PATH}`) {
    return SQLITE_MEMORY_PATH;
  }

  let written = rest;
  if (rest.startsWith("/")) {
    // Three-slash form. The third slash roots the path unless what follows is
    // itself unambiguous: a drive letter, an explicitly relative or home path,
    // or another slash (`sqlite:////abs/path.db`).
    const afterSlash = rest.substring(1);
    if (
      afterSlash.startsWith("/") ||
      WINDOWS_DRIVE_PATH.test(afterSlash) ||
      EXPLICITLY_RELATIVE_PATH.test(afterSlash)
    ) {
      written = afterSlash;
    }
  }

  if (written === "" || written === "/") {
    throw new Error("the DSN does not name a database file");
  }
  return written;
}

/**
 * Resolve a SQLite database path to the absolute path that will be opened.
 * `~/` expands to the home directory and a relative path is resolved against
 * `baseDir`. `:memory:` is a sentinel rather than a path and passes through.
 */
export function resolveSqliteFilePath(database: string, baseDir: string = process.cwd()): string {
  if (database === SQLITE_MEMORY_PATH) {
    return database;
  }

  const expanded = /^~[\\/]/.test(database)
    ? path.join(homedir(), database.substring(2))
    : database;

  // A drive-letter path is absolute wherever the server runs; path.isAbsolute
  // only recognises it on Windows.
  if (path.isAbsolute(expanded) || WINDOWS_DRIVE_PATH.test(expanded)) {
    return expanded;
  }
  return path.resolve(baseDir, expanded);
}

/** The absolute path (or `:memory:`) a SQLite DSN refers to. */
export function resolveSqliteDsnPath(dsn: string, baseDir: string = process.cwd()): string {
  return resolveSqliteFilePath(parseSqliteDsnPath(dsn), baseDir);
}

/**
 * Encode an already-resolved SQLite database path as a DSN that
 * parseSqliteDsnPath decodes back to the same path.
 *
 * A path that itself starts with two slashes (a UNC share) takes the full
 * three-slash prefix; with fewer, one of its own slashes would be read as part
 * of the prefix.
 */
export function buildSqliteDSN(database: string): string {
  if (database === SQLITE_MEMORY_PATH) {
    return `${SQLITE_DSN_PREFIX}/${SQLITE_MEMORY_PATH}`;
  }
  if (database.startsWith("//")) {
    return `${SQLITE_DSN_PREFIX}/${database}`;
  }
  return `${SQLITE_DSN_PREFIX}${database.startsWith("/") ? database : `/${database}`}`;
}

/**
 * Rewrite a SQLite DSN so its path is absolute, resolving a relative path
 * against `baseDir`. Any query string is kept as written.
 */
export function normalizeSqliteDsn(dsn: string, baseDir: string = process.cwd()): string {
  return buildSqliteDSN(resolveSqliteDsnPath(dsn, baseDir)) + splitQuery(dsn).query;
}
