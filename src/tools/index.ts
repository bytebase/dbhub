import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler, executeSqlSchema } from "./execute-sql.js";
import { ConnectorManager } from "../connectors/manager.js";
import { normalizeSourceId } from "../utils/normalize-id.js";

/**
 * Register all tool handlers with the MCP server
 * Creates one execute_sql tool per configured database source
 * @param server - The MCP server instance
 */
export function registerTools(server: McpServer): void {
  // Get all configured source IDs
  const sourceIds = ConnectorManager.getAvailableSourceIds();

  if (sourceIds.length === 0) {
    throw new Error("No database sources configured");
  }

  // For single source with empty ID: register as "execute_sql" (no suffix)
  // For single source with non-empty ID: register as "execute_sql_{id}"
  // For multiple sources: register as "execute_sql_{source_id}" for each source
  if (sourceIds.length === 1) {
    const sourceId = sourceIds[0];
    const sourceConfig = ConnectorManager.getSourceConfig(sourceId);
    const dbType = sourceConfig?.type || "database";

    // If source ID is empty string, use "execute_sql" for backward compatibility
    // Otherwise, suffix with the source ID
    const toolName = sourceId === "" ? "execute_sql" : `execute_sql_${normalizeSourceId(sourceId)}`;

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
      const toolName = `execute_sql_${normalizedId}`;
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
