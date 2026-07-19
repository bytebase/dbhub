/**
 * Shared read-only transaction backstop for the MySQL-family connectors
 * (MySQL, MariaDB), which use identical semantics.
 *
 * Engine-level read-only backstop: run the batch inside a READ ONLY transaction
 * so the server rejects DML writes (INSERT/UPDATE/DELETE/REPLACE) that the
 * keyword classifier missed (e.g. function-based writes). Note this does NOT
 * stop DDL: statements like DROP/CREATE perform an implicit COMMIT that ends the
 * read-only transaction first, so DDL escapes. Stacked-DDL payloads
 * (e.g. `SELECT 1--1;DROP TABLE t`) are instead rejected upstream by the
 * read-only classifier, which splits `--`-hidden statements (see
 * scanSingleLineCommentMySQL in sql-parser.ts).
 *
 * TiDB rejects the READ ONLY modifier (see isTiDBVersion), so there we open a
 * plain transaction and always ROLLBACK instead of COMMIT: any DML the
 * classifier missed is discarded rather than persisted, while SELECT results are
 * unaffected.
 */

/** Minimal shape shared by the mysql2 and mariadb pool connections. */
export interface ReadOnlyTransactionConnection {
  query(sql: string): Promise<unknown>;
}

/**
 * Run `execute` inside the read-only transaction backstop.
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

  await conn.query(
    supportsReadOnlyTransaction ? "START TRANSACTION READ ONLY" : "START TRANSACTION"
  );

  try {
    const result = await execute();
    await conn.query(supportsReadOnlyTransaction ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    // Best-effort rollback so the connection returns to the pool clean.
    try {
      await conn.query("ROLLBACK");
    } catch {
      // ignore rollback failure; the original error is more useful
    }
    throw error;
  }
}
