import { McpServer } from "@modelcontextprotocol/server";
import { createExecuteSqlToolHandler, executeSqlInputSchema } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler, searchDatabaseObjectsInputSchema } from "./search-objects.js";
import { createExplainSqlToolHandler, explainSqlInputSchema } from "./explain-sql.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getExecuteSqlMetadata, getSearchObjectsMetadata, getExplainSqlMetadata } from "../utils/tool-metadata.js";
import { classifySQL } from "../utils/sql-access-policy.js";
import { createCustomToolHandler, getCustomToolInputSchema } from "./custom-tool-handler.js";
import type { ToolConfig } from "../types/config.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL, BUILTIN_TOOL_SEARCH_OBJECTS, BUILTIN_TOOL_EXPLAIN_SQL } from "./builtin-tools.js";

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

  // Register all enabled tools (both built-in and custom) for each source
  for (const sourceId of sourceIds) {
    const enabledTools = registry.getEnabledToolConfigs(sourceId);

    for (const toolConfig of enabledTools) {
      // Register based on tool name (built-in vs custom)
      if (toolConfig.name === BUILTIN_TOOL_EXECUTE_SQL) {
        registerExecuteSqlTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_SEARCH_OBJECTS) {
        registerSearchObjectsTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_EXPLAIN_SQL) {
        registerExplainSqlTool(server, sourceId);
      } else {
        // Custom tool
        registerCustomTool(server, sourceId, toolConfig);
      }
    }
  }
}

/**
 * Register execute_sql tool for a source
 */
function registerExecuteSqlTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getExecuteSqlMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: executeSqlInputSchema,
      annotations: metadata.annotations,
    },
    createExecuteSqlToolHandler(sourceId)
  );
}

/**
 * Register search_objects tool for a source
 */
function registerSearchObjectsTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getSearchObjectsMetadata(sourceId);

  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: searchDatabaseObjectsInputSchema,
      annotations: {
        title: metadata.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createSearchDatabaseObjectsToolHandler(sourceId)
  );
}

/**
 * Register explain_sql tool for a source
 */
function registerExplainSqlTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getExplainSqlMetadata(sourceId);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: explainSqlInputSchema,
      annotations: metadata.annotations,
    },
    createExplainSqlToolHandler(sourceId)
  );
}

/**
 * Register a custom tool
 */
function registerCustomTool(
  server: McpServer,
  sourceId: string,
  toolConfig: ToolConfig
): void {
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;

  // Annotations reflect what the statement actually does, not the tool's
  // readonly config: a SELECT-backed custom tool is read-only regardless.
  const isReadOnly = classifySQL(toolConfig.statement!, dbType) === "read";

  server.registerTool(
    toolConfig.name,
    {
      description: toolConfig.description,
      inputSchema: getCustomToolInputSchema(toolConfig),
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
