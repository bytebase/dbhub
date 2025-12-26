import type { QueryResult } from '../../api/tools';

export interface ResultTab {
  id: string;
  timestamp: Date;
  result: QueryResult | null;
  error: string | null;
  executedSql: string;
  executionTimeMs: number;
}
