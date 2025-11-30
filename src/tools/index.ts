import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler, searchDatabaseObjectsSchema } from "./search-objects.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getToolMetadataForSource } from "../utils/tool-metadata.js";

/**
 * Register all tool handlers with the MCP server
 * Creates tools for each configured database source
 * @param server - The MCP server instance
 */
export function registerTools(server: McpServer): void {
  // Get all configured source IDs
  const sourceIds = ConnectorManager.getAvailableSourceIds();

  if (sourceIds.length === 0) {
    throw new Error("No database sources configured");
  }

  // Register tools for each source
  for (const sourceId of sourceIds) {
    const isDefault = sourceIds[0] === sourceId;
    const sourceConfig = ConnectorManager.getSourceConfig(sourceId);
    const dbType = sourceConfig?.type || "database";

    // 1. execute_sql tool (existing)
    const executeSqlMetadata = getToolMetadataForSource(sourceId);
    server.registerTool(
      executeSqlMetadata.name,
      {
        description: executeSqlMetadata.description,
        inputSchema: executeSqlMetadata.schema,
        annotations: executeSqlMetadata.annotations,
      },
      createExecuteSqlToolHandler(sourceId)
    );

    // 2. search_objects tool (unified search and list)
    const searchToolName = sourceId === "default" ? "search_objects" : `search_objects_${sourceId}`;
    const searchToolTitle = isDefault
      ? `Search Database Objects (${dbType})`
      : `Search Database Objects on ${sourceId} (${dbType})`;
    const searchToolDescription = `Search and list database objects (schemas, tables, columns, procedures, indexes) on the '${sourceId}' ${dbType} database${isDefault ? " (default)" : ""}. Supports SQL LIKE patterns (default: '%' for all), filtering, and token-efficient progressive disclosure.`;

    server.registerTool(
      searchToolName,
      {
        description: searchToolDescription,
        inputSchema: searchDatabaseObjectsSchema,
        annotations: {
          title: searchToolTitle,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true, // Operation is read-only and idempotent
          openWorldHint: true,
        },
      },
      createSearchDatabaseObjectsToolHandler(sourceId)
    );
  }
}
