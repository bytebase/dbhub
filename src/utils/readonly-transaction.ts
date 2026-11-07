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
 * the server rejects the DDL (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION). The
 * session flag is cleared afterwards because the pooled connection is shared
 * with writable tools on the same source. Stacked-DDL payloads
 * (e.g. `SELECT 1--1;DROP TABLE t`) are additionally rejected upstream by the
 * read-only classifier, which splits `--`-hidden statements (see
 * scanSingleLineCommentMySQL in sql-parser.ts).
 *
 * The session flag rides in the same multi-statement batch as the transaction
 * control (both connectors enable multipleStatements), so a read-only execution
 * still costs two round trips beyond the query itself.
 *
 * TiDB rejects the READ ONLY modifier (see isTiDBVersion), so there we open a
 * plain transaction and always ROLLBACK instead of COMMIT: any DML the
 * classifier missed is discarded rather than persisted, while SELECT results are
 * unaffected. DDL on TiDB is stopped by the classifier alone.
 */

import { isClientSideTimeout } from "./query-timeout.js";

/** Minimal shape shared by the mysql2 and mariadb pool connections. */
export interface ReadOnlyTransactionConnection {
  query(sql: string): Promise<unknown>;
}

/** Opens the read-only guard on stock MySQL/MariaDB. */
export const READ_ONLY_OPEN = "SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY";
/** Closes the guard after a successful execution. */
export const READ_ONLY_COMMIT = "COMMIT; SET SESSION TRANSACTION READ WRITE";
/** Closes the guard after a failed execution. */
export const READ_ONLY_ROLLBACK = "ROLLBACK; SET SESSION TRANSACTION READ WRITE";

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
 * @param supportsReadOnlyTransaction False for TiDB, which rejects READ ONLY.
 * @param execute Driver-specific query + result parsing.
 */
export async function withReadOnlyTransaction<T>(
  conn: ReadOnlyTransactionConnection,
  readonly: boolean | undefined,
  supportsReadOnlyTransaction: boolean,
  execute: () => Promise<T>
): Promise<T> {
  if (!readonly) {
    return execute();
  }

  const open = supportsReadOnlyTransaction ? READ_ONLY_OPEN : TIDB_OPEN;
  const commit = supportsReadOnlyTransaction ? READ_ONLY_COMMIT : TIDB_CLOSE;
  const rollback = supportsReadOnlyTransaction ? READ_ONLY_ROLLBACK : TIDB_CLOSE;

  // The open is inside the try so that a failure to open the guard still
  // attempts the best-effort rollback below: if it partially succeeded, or the
  // server left the session with an open transaction or read-only flag, the
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
    // If the reset itself fails, the connection goes back to the pool still
    // read-only, which fails closed: a later writable tool is refused rather
    // than a later read-only one let through.
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
