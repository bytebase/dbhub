import { ApiError } from './errors';

export interface QueryResult {
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
    rows: Record<string, any>[];
    count: number;
    source_id: string;
  } | null;
  error: string | null;
}

export async function executeTool(
  toolName: string,
  args: Record<string, any>
): Promise<QueryResult> {
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

  const mcpResponse: McpResponse = await response.json();

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

  if (!toolResult.data || !toolResult.data.rows) {
    return { columns: [], rows: [], rowCount: 0 };
  }

  const rows = toolResult.data.rows;
  if (rows.length === 0) {
    // For INSERT/UPDATE/DELETE, rows is empty but count reflects affected rows
    return { columns: [], rows: [], rowCount: toolResult.data.count };
  }

  const columns = Object.keys(rows[0]);
  const rowArrays = rows.map((row) => columns.map((col) => row[col]));

  return {
    columns,
    rows: rowArrays,
    rowCount: toolResult.data.count,
  };
}
