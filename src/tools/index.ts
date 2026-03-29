import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler } from "./search-objects.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getExecuteSqlMetadata, getSearchObjectsMetadata } from "../utils/tool-metadata.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";
import { createCustomToolHandler, buildZodSchemaFromParameters } from "./custom-tool-handler.js";
import type { ToolConfig } from "../types/config.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL, BUILTIN_TOOL_SEARCH_OBJECTS } from "./builtin-tools.js";
import { registerListSourcesTool } from "./list-sources.js";

/**
 * Register all tool handlers with the MCP server
 * Iterates through all enabled tools from the registry and registers them
 * @param server - The MCP server instance
 */
export function registerTools(server: McpServer): void {
  const sourceIds = ConnectorManager.getAvailableSourceIds();

  if (sourceIds.length === 0) {
    throw new Error("No database sources configured");
  }

  const registry = getToolRegistry();

  if (sourceIds.length === 1) {
    const enabledTools = registry.getEnabledToolConfigs(sourceIds[0]);

    for (const toolConfig of enabledTools) {
      if (toolConfig.name === BUILTIN_TOOL_EXECUTE_SQL) {
        registerExecuteSqlTool(server, sourceIds[0]);
      } else if (toolConfig.name === BUILTIN_TOOL_SEARCH_OBJECTS) {
        registerSearchObjectsTool(server, sourceIds[0]);
      } else {
        registerCustomTool(server, sourceIds[0], toolConfig);
      }
    }
  } else {
    // Multi-source: 3 generic tools + per-source custom tools
    registerListSourcesTool(server);
    registerExecuteSqlTool(server, undefined);
    registerSearchObjectsTool(server, undefined);

    for (const sourceId of sourceIds) {
      for (const toolConfig of registry.getCustomToolsForSource(sourceId)) {
        registerCustomTool(server, sourceId, toolConfig);
      }
    }
  }
}

/**
 * Register execute_sql tool for a source (or generic multi-source tool if sourceId is undefined)
 */
function registerExecuteSqlTool(server: McpServer, sourceId?: string): void {
  const metadata = getExecuteSqlMetadata(sourceId);
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

/**
 * Register search_objects tool for a source (or generic multi-source tool if sourceId is undefined)
 */
function registerSearchObjectsTool(server: McpServer, sourceId?: string): void {
  const metadata = getSearchObjectsMetadata(sourceId);

  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: metadata.schema,
      annotations: metadata.annotations,
    },
    createSearchDatabaseObjectsToolHandler(sourceId)
  );
}

/**
 * Register a custom tool
 */
function registerCustomTool(server: McpServer, sourceId: string, toolConfig: ToolConfig): void {
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;

  const isReadOnly = isReadOnlySQL(toolConfig.statement!, dbType);
  const zodSchema = buildZodSchemaFromParameters(toolConfig.parameters);

  server.registerTool(
    toolConfig.name,
    {
      description: toolConfig.description,
      inputSchema: zodSchema,
      annotations: {
        title: `${toolConfig.name} (${dbType})`,
        readOnlyHint: isReadOnly,
        destructiveHint: !isReadOnly,
        idempotentHint: isReadOnly,
        openWorldHint: false,
      },
    },
    createCustomToolHandler(toolConfig)
  );
}
