import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler, searchDatabaseObjectsSchema } from "./search-objects.js";
import { createRedisCommandToolHandler, redisCommandSchema } from "./redis-command-handler.js";
import { createElasticsearchSearchToolHandler, elasticsearchSearchSchema } from "./elasticsearch-search-handler.js";
import { createGenerateCodeToolHandler } from "./generate-code-handler.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getExecuteSqlMetadata, getSearchObjectsMetadata, getRedisCommandMetadata, getElasticsearchSearchMetadata, getGenerateCodeMetadata } from "../utils/tool-metadata.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";
import { createCustomToolHandler, buildZodSchemaFromParameters } from "./custom-tool-handler.js";
import type { ToolConfig } from "../types/config.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL, BUILTIN_TOOL_SEARCH_OBJECTS, BUILTIN_TOOL_REDIS_COMMAND, BUILTIN_TOOL_ELASTICSEARCH_SEARCH, BUILTIN_TOOL_GENERATE_CODE } from "./builtin-tools.js";

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

  // Register global tools (not tied to a specific source)
  registerGenerateCodeTool(server);

  // Register all enabled tools (both built-in and custom) for each source
  for (const sourceId of sourceIds) {
    const enabledTools = registry.getEnabledToolConfigs(sourceId);

    for (const toolConfig of enabledTools) {
      // Register based on tool name (built-in vs custom)
      if (toolConfig.name === BUILTIN_TOOL_EXECUTE_SQL) {
        registerExecuteSqlTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_SEARCH_OBJECTS) {
        registerSearchObjectsTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_REDIS_COMMAND) {
        registerRedisCommandTool(server, sourceId);
      } else if (toolConfig.name === BUILTIN_TOOL_ELASTICSEARCH_SEARCH) {
        registerElasticsearchSearchTool(server, sourceId);
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
      inputSchema: metadata.schema,
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
      inputSchema: searchDatabaseObjectsSchema,
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
 * Register redis_command tool for a source
 */
function registerRedisCommandTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getRedisCommandMetadata(sourceId);

  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: redisCommandSchema,
      annotations: {
        title: metadata.title,
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    createRedisCommandToolHandler(sourceId)
  );
}

/**
 * Register elasticsearch_search tool for a source
 */
function registerElasticsearchSearchTool(
  server: McpServer,
  sourceId: string
): void {
  const metadata = getElasticsearchSearchMetadata(sourceId);

  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: elasticsearchSearchSchema,
      annotations: {
        title: metadata.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createElasticsearchSearchToolHandler(sourceId)
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
  // Type guard: only custom tools have description and statement
  if (toolConfig.name === "execute_sql" || toolConfig.name === "search_objects") {
    return;
  }

  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;

  const isReadOnly = isReadOnlySQL(toolConfig.statement, dbType);
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

/**
 * Register generate_code tool (global, not source-specific)
 */
function registerGenerateCodeTool(server: McpServer): void {
  const metadata = getGenerateCodeMetadata();
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: metadata.schema,
      annotations: metadata.annotations,
    },
    createGenerateCodeToolHandler()
  );
}
