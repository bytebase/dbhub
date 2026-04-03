import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse } from "../utils/response-formatter.js";

/**
 * Register the list_sources meta-tool with the MCP server.
 * Only registered in multi-source mode.
 */
export function registerListSourcesTool(server: McpServer): void {
  server.registerTool(
    "list_sources",
    {
      description:
        "List all available database sources. Call this first to discover source IDs, then pass source_id to execute_sql or search_objects.",
      inputSchema: {},
      annotations: {
        title: "List Database Sources",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const sourceIds = ConnectorManager.getAvailableSourceIds();
      const sources = sourceIds.map((id) => {
        const config = ConnectorManager.getSourceConfig(id);
        return {
          id,
          type: config?.type,
        };
      });
      return createToolSuccessResponse({ sources });
    }
  );
}
