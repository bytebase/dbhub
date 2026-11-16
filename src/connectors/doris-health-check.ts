import type { HealthCheckResult } from "./interface.js";
import { toNullableNumber } from "./health-check-utils.js";

type DorisHealthCheckSection = "connections" | "frontends" | "backends";

export class DorisHealthCheckError extends Error {
  constructor(
    readonly section: DorisHealthCheckSection,
    readonly originalError: unknown
  ) {
    super(
      `Doris health check ${section} failed: ${originalError instanceof Error ? originalError.message : String(originalError)}`
    );
    this.name = "DorisHealthCheckError";
  }
}

/** Collect Doris diagnostics without assuming MySQL's transaction or cache tables exist. */
export async function getDorisHealthCheck(
  query: (sql: string) => Promise<any[]>
): Promise<HealthCheckResult> {
  const collect = async (section: DorisHealthCheckSection, sql: string): Promise<any[]> => {
    try {
      return await query(sql);
    } catch (error) {
      throw new DorisHealthCheckError(section, error);
    }
  };
  const [connections, frontends, backends] = await Promise.all([
    collect(
      "connections",
      `
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN COMMAND != 'Sleep' THEN 1 ELSE 0 END), 0) AS active,
        COALESCE(SUM(CASE WHEN COMMAND = 'Sleep' THEN 1 ELSE 0 END), 0) AS idle,
        MAX(CASE WHEN COMMAND != 'Sleep' THEN TIME ELSE NULL END) AS longest_active_query_seconds
      FROM information_schema.PROCESSLIST
      WHERE ID <> CONNECTION_ID()
    `
    ),
    collect("frontends", "SHOW FRONTENDS"),
    collect("backends", "SHOW BACKENDS"),
  ]);
  const connection = connections[0];
  return {
    connections: {
      total: Number(connection.total),
      active: Number(connection.active),
      idle: Number(connection.idle),
      idleInTransaction: null,
      maxConnections: null,
      longestIdleInTransactionSeconds: null,
      longestActiveQuerySeconds: toNullableNumber(connection.longest_active_query_seconds),
    },
    nodes: { frontends, backends },
    notes: [
      "Connection counts cover only visible sessions, excluding the counting query's own session; other pooled or concurrent diagnostic sessions may appear. They are not cluster totals.",
      "Queries run concurrently and are not a point-in-time snapshot. Success means collection succeeded, not that the database or cluster is healthy.",
      "Idle-in-transaction, maximum connections and buffer-cache metrics are not collected for Doris; null or omitted metrics do not mean zero.",
      "Native FE/BE columns and values are preserved without helper conversions; field types vary by Doris version and driver, not a stable cross-version contract. Shared JSON serialization converts safe BigInt values to numbers and larger BigInt values to strings.",
      "Empty node lists do not establish health. Cloud Mode disk-capacity fields may contain placeholder values.",
    ],
  };
}
