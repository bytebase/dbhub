import { HealthCheckResult } from "./interface.js";
import { computeHitRatioPct, toNullableNumber } from "./health-check-utils.js";

/**
 * Row-array query adapter - lets MySQL (mysql2, returns [rows, fields]) and
 * MariaDB (mariadb, returns rows directly) share one implementation despite
 * their differing driver response shapes.
 */
type QueryRows = (sql: string) => Promise<any[]>;

/**
 * Shared getHealthCheck() implementation for MySQL and MariaDB - both
 * engines expose the same information_schema/SHOW-based diagnostics.
 */
export async function getMySQLFamilyHealthCheck(query: QueryRows): Promise<HealthCheckResult> {
  const [processlistRows, maxConnRows, bufferPoolRows, trxOutcome] = await Promise.all([
    query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN COMMAND != 'Sleep' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN COMMAND = 'Sleep' THEN 1 ELSE 0 END) AS idle,
        MAX(CASE WHEN COMMAND != 'Sleep' THEN TIME ELSE NULL END) AS longest_active_query_seconds
      FROM information_schema.PROCESSLIST
      WHERE ID <> CONNECTION_ID()
    `),
    query(`SHOW VARIABLES LIKE 'max_connections'`),
    query(`
      SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads')
    `),
    // Joining PROCESSLIST against INNODB_TRX to detect idle-in-transaction
    // sessions requires the PROCESS privilege - unlike a plain PROCESSLIST
    // select, which silently narrows to the caller's own session instead of
    // erroring. Run concurrently with the other queries above, but resolve
    // rather than reject on failure so it degrades instead of failing the
    // whole health check.
    query(`
      SELECT
        COUNT(*) AS idle_in_transaction,
        MAX(TIMESTAMPDIFF(SECOND, t.trx_started, NOW())) AS longest_idle_in_transaction_seconds
      FROM information_schema.INNODB_TRX t
      JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id
      WHERE p.COMMAND = 'Sleep'
    `).then(
      (rows) => ({ ok: true as const, rows }),
      () => ({ ok: false as const })
    ),
  ]);

  const notes: string[] = [];
  let idleInTransaction = 0;
  let longestIdleInTransactionSeconds: number | null = null;
  if (trxOutcome.ok) {
    idleInTransaction = Number(trxOutcome.rows[0].idle_in_transaction);
    longestIdleInTransactionSeconds = toNullableNumber(trxOutcome.rows[0].longest_idle_in_transaction_seconds);
  } else {
    notes.push(
      "Connected user lacks the PROCESS privilege: PROCESSLIST visibility is restricted to the connecting user's own sessions, and this diagnostic session is excluded from the count, so connection counts and active-query duration may under-report (down to 0). Idle-in-transaction detection is unavailable."
    );
  }

  const proc = processlistRows[0];
  const bufferPoolStats = Object.fromEntries(bufferPoolRows.map((row: any) => [row.Variable_name, row.Value]));
  const readRequests = Number(bufferPoolStats.Innodb_buffer_pool_read_requests ?? 0);
  const reads = Number(bufferPoolStats.Innodb_buffer_pool_reads ?? 0);

  return {
    connections: {
      total: Number(proc.total),
      active: Number(proc.active),
      idle: Number(proc.idle),
      idleInTransaction,
      // MySQL/MariaDB's InnoDB has no equivalent of Postgres's "idle in
      // transaction (aborted)" state - a failed statement doesn't leave the
      // session's transaction in a distinct aborted-but-open state the way
      // Postgres does - so idleInTransactionAborted is left undefined.
      maxConnections: maxConnRows.length > 0 ? Number(maxConnRows[0].Value) : null,
      longestIdleInTransactionSeconds,
      longestActiveQuerySeconds: toNullableNumber(proc.longest_active_query_seconds),
    },
    bufferCache: {
      hitRatioPct: computeHitRatioPct(readRequests, reads),
      blocksHit: readRequests - reads,
      blocksRead: reads,
    },
    ...(notes.length > 0 ? { notes } : {}),
  };
}
