import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler, searchDatabaseObjectsSchema } from "./search-objects.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getExecuteSqlMetadata, getSearchObjectsMetadata } from "../utils/tool-metadata.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";
import { createCustomToolHandler, buildZodSchemaFromParameters } from "./custom-tool-handler.js";
import type { ToolConfig } from "../types/config.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL, BUILTIN_TOOL_SEARCH_OBJECTS } from "./builtin-tools.js";
import { isMinimalDescriptionsMode } from "../config/env.js";

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
  const isMinimal = isMinimalDescriptionsMode();

  // In minimal mode, register consolidated tools once (with database parameter)
  if (isMinimal) {
    // Track which built-in tools have been registered
    let executeSqlRegistered = false;
    let searchObjectsRegistered = false;

    // Check all sources to see which tools are enabled
    for (const sourceId of sourceIds) {
      const enabledTools = registry.getEnabledToolConfigs(sourceId);
      const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
      const dbType = sourceConfig.type;

      for (const toolConfig of enabledTools) {
        if (toolConfig.name === BUILTIN_TOOL_EXECUTE_SQL && !executeSqlRegistered) {
          registerExecuteSql(server, sourceIds);
          executeSqlRegistered = true;
        } else if (toolConfig.name === BUILTIN_TOOL_SEARCH_OBJECTS && !searchObjectsRegistered) {
          registerSearchObjects(server, sourceIds);
          searchObjectsRegistered = true;
        } else if (toolConfig.name !== BUILTIN_TOOL_EXECUTE_SQL && toolConfig.name !== BUILTIN_TOOL_SEARCH_OBJECTS) {
          // Custom tools are still registered per-source
          registerCustomTool(server, toolConfig, dbType);
        }
      }
    }
  } else {
    // Standard mode: register tools per source
    for (const sourceId of sourceIds) {
      const enabledTools = registry.getEnabledToolConfigs(sourceId);
      const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
      const dbType = sourceConfig.type;
      const isDefault = sourceIds[0] === sourceId;

      for (const toolConfig of enabledTools) {
        // Register based on tool name (built-in vs custom)
        if (toolConfig.name === BUILTIN_TOOL_EXECUTE_SQL) {
          registerExecuteSqlTool(server, sourceId, dbType);
        } else if (toolConfig.name === BUILTIN_TOOL_SEARCH_OBJECTS) {
          registerSearchObjectsTool(server, sourceId, dbType, isDefault);
        } else {
          // Custom tool
          registerCustomTool(server, toolConfig, dbType);
        }
      }
    }
  }
}

/**
 * Register execute_sql tool for a source
 */
function registerExecuteSqlTool(
  server: McpServer,
  sourceId: string,
  dbType: string
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
  sourceId: string,
  dbType: string,
  isDefault: boolean
): void {
  const metadata = getSearchObjectsMetadata(sourceId, dbType, isDefault);

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
 * Register a custom tool
 */
function registerCustomTool(
  server: McpServer,
  toolConfig: ToolConfig,
  dbType: string
): void {
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

  console.error(`  - ${toolConfig.name} → ${toolConfig.source} (${dbType})`);
}

interface ExecuteSqlArgs {
  sql: string;
  database?: string;
}

interface SearchObjectsArgs {
  object_type: string;
  pattern?: string;
  schema?: string;
  table?: string;
  detail_level?: string;
  limit?: number;
  database?: string;
}

/**
 * Register consolidated execute_sql tool (minimal mode)
 */
function registerExecuteSql(server: McpServer, sourceIds: string[]): void {
  const metadata = getExecuteSqlMetadata(sourceIds[0]);
  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: metadata.schema,
      annotations: metadata.annotations,
    },
    async (args: ExecuteSqlArgs, extra: unknown) => {
      const sourceId = args.database || sourceIds[0];
      return createExecuteSqlToolHandler(sourceId)(args, extra);
    }
  );
  console.error(`  - execute_sql (consolidated, databases: ${sourceIds.join(", ")})`);
}

/**
 * Register consolidated search_objects tool (minimal mode)
 */
function registerSearchObjects(server: McpServer, sourceIds: string[]): void {
  const sourceConfig = ConnectorManager.getSourceConfig(sourceIds[0])!;
  const metadata = getSearchObjectsMetadata(sourceIds[0], sourceConfig.type, true);
  const schema = metadata.databaseSchema
    ? { ...searchDatabaseObjectsSchema, database: metadata.databaseSchema }
    : searchDatabaseObjectsSchema;

  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema: schema,
      annotations: {
        title: metadata.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: SearchObjectsArgs, extra: unknown) => {
      const sourceId = args.database || sourceIds[0];
      return createSearchDatabaseObjectsToolHandler(sourceId)(args, extra);
    }
  );
  console.error(`  - search_objects (consolidated, databases: ${sourceIds.join(", ")})`);
}
