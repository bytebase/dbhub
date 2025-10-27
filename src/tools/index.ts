import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeSqlToolHandler, executeSqlSchema } from "./execute-sql.js";
/**
 * Register all tool handlers with the MCP server
 * @param server - The MCP server instance
 * @param id - Optional database ID to suffix tool names (for multi-database support)
 */
export function registerTools(server: McpServer, id?: string): void {
  // Build tool name with optional database ID suffix
  const toolName = id ? `execute_sql_${id}` : "execute_sql";

  // Tool to run a SQL query (read-only for safety)
  server.tool(
    toolName,
    `Execute a SQL query on the ${id ? id : 'current'} database`,
    executeSqlSchema,
    (args, extra) => executeSqlToolHandler(args, extra, id)
  );

}
