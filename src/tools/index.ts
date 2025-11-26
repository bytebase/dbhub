import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler, executeSqlSchema } from "./execute-sql.js";
import { ConnectorManager } from "../connectors/manager.js";
import { normalizeSourceId } from "../utils/normalize-id.js";

/**
 * Register all tool handlers with the MCP server
 * Creates one execute_sql tool per configured database source
 * @param server - The MCP server instance
 * @param id - Optional ID to suffix tool names (for Cursor multi-instance support)
 */
export function registerTools(server: McpServer, id?: string): void {
  // Get all configured source IDs
  const sourceIds = ConnectorManager.getAvailableSourceIds();

  if (sourceIds.length === 0) {
    throw new Error("No database sources configured");
  }

  // For single source: register as "execute_sql" (backward compatible)
  // For multiple sources: register as "execute_sql_{source_id}" for each source
  if (sourceIds.length === 1) {
    const sourceId = sourceIds[0];
    const toolName = id ? `execute_sql_${id}` : "execute_sql";
    const sourceConfig = ConnectorManager.getSourceConfig(sourceId);
    const dbType = sourceConfig?.type || "database";

    server.tool(
      toolName,
      `Execute a SQL query on the ${dbType} database`,
      executeSqlSchema,
      createExecuteSqlToolHandler(sourceId)
    );
  } else {
    // Multiple sources: create one tool per source
    for (const sourceId of sourceIds) {
      const normalizedId = normalizeSourceId(sourceId);
      const toolName = id ? `execute_sql_${normalizedId}_${id}` : `execute_sql_${normalizedId}`;
      const sourceConfig = ConnectorManager.getSourceConfig(sourceId);
      const dbType = sourceConfig?.type || "database";
      const isDefault = sourceIds[0] === sourceId;

      server.tool(
        toolName,
        `Execute a SQL query on the '${sourceId}' ${dbType} database${isDefault ? " (default)" : ""}`,
        executeSqlSchema,
        createExecuteSqlToolHandler(sourceId)
      );
    }
  }
}
