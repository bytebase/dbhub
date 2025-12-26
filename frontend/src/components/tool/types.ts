import type { StatementResult } from '../../api/tools';

export interface ResultTab {
  id: string;
  timestamp: Date;
  result: StatementResult | null;
  error: string | null;
  executionTimeMs: number;
}
