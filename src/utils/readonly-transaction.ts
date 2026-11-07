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
 * default or an `init_connect` hook, and that must survive. The value is saved
 * in a user variable on the connection before the flag is raised and read back
 * from it afterwards, so nothing has to be parsed client-side. Stacked-DDL
 * payloads (e.g. `SELECT 1--1;DROP TABLE t`) are additionally rejected upstream
 * by the read-only classifier, which splits `--`-hidden statements (see
 * scanSingleLineCommentMySQL in sql-parser.ts).
 *
 * Save, flag and transaction control ride in one multi-statement batch on each
 * side (both connectors enable multipleStatements), so a read-only execution
 * still costs two round trips beyond the query itself.
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

/** User variable holding the connection's own value of the flag while it is raised. */
const SAVED_FLAG = "@dbhub_tx_read_only";

/** Opens the guard on stock MySQL/MariaDB: save the flag, raise it, begin. */
export function readOnlyOpen(variable: ReadOnlyVariable): string {
  return (
    `SET ${SAVED_FLAG} := @@session.${variable}; ` +
    "SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY"
  );
}

/**
 * Closes the guard: end the transaction, then put the flag back to the saved
 * value. If the open batch failed before the save, nothing was raised, so the
 * flag is left as it is (COALESCE on its current value).
 */
export function readOnlyClose(variable: ReadOnlyVariable, end: "COMMIT" | "ROLLBACK"): string {
  return `${end}; SET SESSION ${variable} = COALESCE(${SAVED_FLAG}, @@session.${variable})`;
}

/** TiDB counterparts: no READ ONLY, and always discard. */
export const TIDB_OPEN = "START TRANSACTION";
export const TIDB_CLOSE = "ROLLBACK";

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

  const session = backstop.kind === "session";
  const open = session ? readOnlyOpen(backstop.variable) : TIDB_OPEN;
  const commit = session ? readOnlyClose(backstop.variable, "COMMIT") : TIDB_CLOSE;
  const rollback = session ? readOnlyClose(backstop.variable, "ROLLBACK") : TIDB_CLOSE;

  // The open is inside the try so that a failure to open the guard still
  // attempts the best-effort rollback below: if it partially succeeded, or the
  // server left the session with an open transaction or a raised flag, the
  // connection must not go back to the pool dirty.
  try {
    await conn.query(open);
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
