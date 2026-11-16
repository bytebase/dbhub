import type { QueryResult } from '../../api/tools';

export interface ResultTab {
  id: string;
  timestamp: Date;
  result: QueryResult | null;
  error: string | null;
  executedSql: string;
  /** Request duration is available only on the first result of a batch. */
  executionTimeMs?: number;
  /** 1-based position of this statement within its batch, when the batch had more than one. */
  statementIndex?: number;
  /** Total number of statements in the batch this tab's statement belongs to. */
  statementTotal?: number;
}
