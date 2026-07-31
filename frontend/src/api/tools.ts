import { ApiError } from './errors';

export interface QueryResult {
  /** Source text of the statement that produced this result, when known. */
  sql?: string;
  columns: string[];
  rows: any[][];
  rowCount: number;
}

interface McpResponse {
  jsonrpc: string;
  id: string;
  result?: {
    content: Array<{ type: string; text: string }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

interface ToolResultData {
  success: boolean;
  data: {
    statements: Array<{
      sql?: string;
      rows: Record<string, any>[];
      count: number;
    }>;
    source_id: string;
  } | null;
  error: string | null;
}

function toQueryResult(statement: { sql?: string; rows: Record<string, any>[]; count: number }): QueryResult {
  if (statement.rows.length === 0) {
    // For INSERT/UPDATE/DELETE, rows is empty but count reflects affected rows
    return { sql: statement.sql, columns: [], rows: [], rowCount: statement.count };
  }

  const columns = Object.keys(statement.rows[0]);
  const rowArrays = statement.rows.map((row) => columns.map((col) => row[col]));

  return { sql: statement.sql, columns, rows: rowArrays, rowCount: statement.count };
}

/**
 * Executes a tool and returns one `QueryResult` per statement in the batch -
 * a single SELECT (the common case) is an array of length 1, rather than
 * different statements' rows being merged together.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, any>
): Promise<QueryResult[]> {
  const response = await fetch('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!response.ok) {
    throw new ApiError(`HTTP error: ${response.status}`, response.status);
  }

  // The stateless legacy path (2025-era MCP clients) answers spec-standard
  // SSE framing - a single "data: {...}" event per exchange - rather than a
  // plain JSON body, even though this fetch requests both content types.
  const text = await response.text();
  let mcpResponse: McpResponse;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) {
      throw new ApiError('No data event in SSE response', 500);
    }
    mcpResponse = JSON.parse(dataLine.slice('data: '.length));
  } else {
    mcpResponse = JSON.parse(text);
  }

  if (mcpResponse.error) {
    throw new ApiError(mcpResponse.error.message, mcpResponse.error.code);
  }

  if (!mcpResponse.result?.content?.[0]?.text) {
    throw new ApiError('Invalid response format', 500);
  }

  const toolResult: ToolResultData = JSON.parse(mcpResponse.result.content[0].text);

  if (!toolResult.success || toolResult.error) {
    throw new ApiError(toolResult.error || 'Tool execution failed', 500);
  }

  if (!toolResult.data || !toolResult.data.statements) {
    return [{ columns: [], rows: [], rowCount: 0 }];
  }

  return toolResult.data.statements.map(toQueryResult);
}
