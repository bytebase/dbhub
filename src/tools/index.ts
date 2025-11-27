import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler } from "./execute-sql.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getToolMetadataForSource } from "../utils/tool-metadata.js";

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

  // Register tools for each source using shared metadata logic
  for (const sourceId of sourceIds) {
    const metadata = getToolMetadataForSource(sourceId);

    server.registerTool(
      metadata.name,
      {
        description: metadata.description,
        inputSchema: metadata.schema,
        annotations: metadata.annotations,
      },
      createExecuteSqlToolHandler(sourceId)
    );
  }
}
