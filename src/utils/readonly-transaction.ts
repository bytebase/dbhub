/**
 * Shared read-only backstop for the MySQL-family connectors (MySQL, MariaDB),
 * which use identical semantics.
 *
 * Engine-level read-only backstop: run the batch inside a READ ONLY transaction
 * so the server rejects DML writes (INSERT/UPDATE/DELETE/REPLACE) that the
 * keyword classifier missed (e.g. function-based writes).
 *
 * The transaction alone does not stop DDL: statements like DROP/CREATE perform
 * an implicit COMMIT that ends the read-only transaction first, and the DDL
 * then runs in a fresh, writable one. So the session itself is also set READ
 * ONLY for the duration (`SET SESSION TRANSACTION READ ONLY`): every transaction
 * the connection opens, the one the DDL starts included, is then read-only and
 * the server rejects the DDL (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION).
 *
 * The session flag is restored afterwards, not cleared: the pooled connection
 * is shared with writable tools on the same source, but its previous value may
 * itself be read-only, set by the operator (`[sources.session]`), a global
 * default or an `init_connect` hook, and that must survive. The value is read
 * into application state before the flag is raised and restored as a literal,
 * never via anything the executed SQL can reach: a user variable, for example,
 * can be overwritten by a `SELECT @v := 0`, which the classifier allows and a
 * read-only transaction permits. Stacked-DDL payloads (e.g.
 * `SELECT 1--1;DROP TABLE t`) are additionally rejected upstream by the
 * read-only classifier, which splits `--`-hidden statements (see
 * scanSingleLineCommentMySQL in sql-parser.ts).
 *
 * Flag and transaction control ride in one multi-statement batch on each side
 * (both connectors enable multipleStatements); with the read of the flag's
 * current value, a read-only execution costs three round trips beyond the query
 * itself.
 *
 * TiDB rejects the READ ONLY modifier (see isTiDBVersion), so there we open a
 * plain transaction and always ROLLBACK instead of COMMIT: any DML the
 * classifier missed is discarded rather than persisted, while SELECT results are
 * unaffected. DDL on TiDB is stopped by the classifier alone.
 */

import { isClientSideTimeout } from "./query-timeout.js";
import { isTiDBVersion } from "./server-flavor.js";

/** Minimal shape shared by the mysql2 and mariadb pool connections. */
export interface ReadOnlyTransactionConnection {
  query(sql: string): Promise<unknown>;
}

/**
 * The session variable behind `SET SESSION TRANSACTION READ ONLY`, which is
 * what has to be saved and restored. MySQL renamed `tx_read_only` to
 * `transaction_read_only` in 5.7.20 and dropped the old name in 8.0.3;
 * MariaDB has `tx_read_only` throughout (11.1 added the new name as an alias).
 */
export type ReadOnlyVariable = "transaction_read_only" | "tx_read_only";

/** How the backstop takes effect on this server, detected once at connect time. */
export type ReadOnlyBackstop =
  /** Stock MySQL/MariaDB: session READ ONLY around a READ ONLY transaction. */
  | { kind: "session"; variable: ReadOnlyVariable }
  /** TiDB: plain transaction, always rolled back. */
  | { kind: "rollback" };

/** Pick the backstop from the server's `SELECT VERSION()` string. */
export function detectReadOnlyBackstop(version: unknown): ReadOnlyBackstop {
  if (isTiDBVersion(version)) {
    return { kind: "rollback" };
  }
  return { kind: "session", variable: readOnlyVariableFor(version) };
}

function readOnlyVariableFor(version: unknown): ReadOnlyVariable {
  if (typeof version !== "string") {
    return "transaction_read_only";
  }
  if (/mariadb/i.test(version)) {
    return "tx_read_only";
  }
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match) {
    const [major, minor, patch] = match.slice(1).map(Number);
    const before5720 = major < 5 || (major === 5 && (minor < 7 || (minor === 7 && patch < 20)));
    if (before5720) {
      return "tx_read_only";
    }
  }
  return "transaction_read_only";
}

/** Reads the flag's current value, so it can be put back afterwards. */
export function readOnlyFlagQuery(variable: ReadOnlyVariable): string {
  return `SELECT @@session.${variable} AS ro`;
}

/** Opens the guard on stock MySQL/MariaDB: raise the flag, begin. */
export const READ_ONLY_OPEN = "SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY";

/** Closes the guard: end the transaction, then put the flag back to `saved`. */
export function readOnlyClose(
  variable: ReadOnlyVariable,
  end: "COMMIT" | "ROLLBACK",
  saved: 0 | 1
): string {
  return `${end}; SET SESSION ${variable} = ${saved}`;
}

/** TiDB counterparts: no READ ONLY, and always discard. */
export const TIDB_OPEN = "START TRANSACTION";
export const TIDB_CLOSE = "ROLLBACK";

/**
 * Read the flag into application state. Refuses to proceed on anything but a
 * clear 0 or 1: guessing "writable" could later clear a read-only default.
 */
async function readFlag(
  conn: ReadOnlyTransactionConnection,
  variable: ReadOnlyVariable
): Promise<0 | 1> {
  const result = await conn.query(readOnlyFlagQuery(variable));
  // mysql2 resolves a string query to [rows, fields]; mariadb to the rows.
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  const value = parseFlag((rows as Array<{ ro?: unknown }> | undefined)?.[0]?.ro);
  if (value === undefined) {
    throw new Error(`Could not read @@session.${variable} before a read-only execution`);
  }
  return value;
}

/**
 * Accept only an exact 0 or 1, as a number, bigint or their decimal strings
 * (drivers differ in how they hand back a system variable). No coercion:
 * `Number(null)` and `Number("")` are 0, which would read as "writable".
 */
function parseFlag(raw: unknown): 0 | 1 | undefined {
  if (raw === 0 || raw === 0n || raw === "0") return 0;
  if (raw === 1 || raw === 1n || raw === "1") return 1;
  return undefined;
}

/**
 * Run `execute` inside the read-only backstop.
 *
 * When `readonly` is false the callback runs untouched, so callers can wrap
 * unconditionally.
 *
 * @param conn Pool connection; must be the same connection the callback queries on.
 * @param readonly Whether read-only enforcement is active for this execution.
 * @param backstop The server's backstop form, from detectReadOnlyBackstop.
 * @param execute Driver-specific query + result parsing.
 */
export async function withReadOnlyTransaction<T>(
  conn: ReadOnlyTransactionConnection,
  readonly: boolean | undefined,
  backstop: ReadOnlyBackstop,
  execute: () => Promise<T>
): Promise<T> {
  if (!readonly) {
    return execute();
  }

  // A bare ROLLBACK until the flag has been raised: if the read of its value
  // fails there is nothing to restore, only a transaction to clean up.
  let rollback = TIDB_CLOSE;
  // The open is inside the try so that a failure to open the guard still
  // attempts the best-effort rollback below: if it partially succeeded, or the
  // server left the session with an open transaction or a raised flag, the
  // connection must not go back to the pool dirty.
  try {
    let commit: string;
    if (backstop.kind === "session") {
      // Read before raising, into a local the executed SQL cannot reach.
      const saved = await readFlag(conn, backstop.variable);
      rollback = readOnlyClose(backstop.variable, "ROLLBACK", saved);
      commit = readOnlyClose(backstop.variable, "COMMIT", saved);
      await conn.query(READ_ONLY_OPEN);
    } else {
      commit = TIDB_CLOSE;
      await conn.query(TIDB_OPEN);
    }
    const result = await execute();
    await conn.query(commit);
    return result;
  } catch (error) {
    // Best-effort rollback so the connection returns to the pool clean.
    // Skipped for a client-side timeout: the connection is still busy with the
    // abandoned statement, so the ROLLBACK would queue behind it (see
    // isClientSideTimeout). The connector discards the connection instead.
    // If the restore itself fails, the connection goes back to the pool with
    // the flag still raised, which fails closed: a later writable tool is
    // refused rather than a later read-only one let through.
    if (!isClientSideTimeout(error)) {
      try {
        await conn.query(rollback);
      } catch {
        // ignore rollback failure; the original error is more useful
      }
    }
    throw error;
  }
}
