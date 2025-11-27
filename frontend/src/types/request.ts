export interface Request {
  id: string;
  timestamp: string;
  sourceId: string;
  toolName: string;
  sql: string;
  durationMs: number;
  client: string;
  success: boolean;
  error?: string;
}

export interface RequestsResponse {
  requests: Request[];
  total: number;
}
