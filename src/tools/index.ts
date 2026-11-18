import { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { createExecuteSqlToolHandler, executeSqlInputSchema } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler, searchDatabaseObjectsInputSchema } from "./search-objects.js";
import { createExplainSqlToolHandler, explainSqlInputSchema } from "./explain-sql.js";
import { createHealthCheckToolHandler, healthCheckInputSchema } from "./health-check.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getBuiltinToolMetadata } from "../utils/tool-metadata.js";
import type { ToolResponse } from "../utils/tool-handler-helpers.js";
import { classifySQL } from "../utils/sql-access-policy.js";
import { createCustomToolHandler, getCustomToolInputSchema } from "./custom-tool-handler.js";
import type { ToolConfig } from "../types/config.js";
import { getToolRegistry } from "./registry.js";
import {
  BUILTIN_TOOL_EXECUTE_SQL,
  BUILTIN_TOOL_SEARCH_OBJECTS,
  BUILTIN_TOOL_EXPLAIN_SQL,
  BUILTIN_TOOL_HEALTH_CHECK,
  isBuiltinToolName,
  type BuiltinToolName,
} from "./builtin-tools.js";

/**
 * The executable half of each built-in tool: the input schema it is registered
 * with and the factory for its per-source handler. The descriptive half (name,
 * description, annotations) comes from getBuiltinToolMetadata, which the API
 * tool list shares. Adding a built-in means one entry here and one there;
 * builtin-tool-table.integration.test.ts fails if either is missing.
 */
export const BUILTIN_TOOL_HANDLERS: Record<
  BuiltinToolName,
  {
    inputSchema: z.ZodObject<any>;
    createHandler: (sourceId: string) => (args: any, extra: any) => Promise<ToolResponse>;
  }
> = {
  [BUILTIN_TOOL_EXECUTE_SQL]: {
    inputSchema: executeSqlInputSchema,
    createHandler: createExecuteSqlToolHandler,
  },
  [BUILTIN_TOOL_SEARCH_OBJECTS]: {
    inputSchema: searchDatabaseObjectsInputSchema,
    createHandler: createSearchDatabaseObjectsToolHandler,
  },
  [BUILTIN_TOOL_EXPLAIN_SQL]: {
    inputSchema: explainSqlInputSchema,
    createHandler: createExplainSqlToolHandler,
  },
  [BUILTIN_TOOL_HEALTH_CHECK]: {
    inputSchema: healthCheckInputSchema,
    createHandler: createHealthCheckToolHandler,
  },
};

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
    for (const toolConfig of registry.getEnabledToolConfigs(sourceId)) {
      if (isBuiltinToolName(toolConfig.name)) {
        registerBuiltinTool(server, toolConfig.name, sourceId);
      } else {
        registerCustomTool(server, sourceId, toolConfig);
      }
    }
  }
}

/**
 * Register a built-in tool for a source
 */
function registerBuiltinTool(server: McpServer, name: BuiltinToolName, sourceId: string): void {
  const metadata = getBuiltinToolMetadata(name, sourceId);
  const { inputSchema, createHandler } = BUILTIN_TOOL_HANDLERS[name];

  server.registerTool(
    metadata.name,
    {
      description: metadata.description,
      inputSchema,
      annotations: metadata.annotations,
    },
    createHandler(sourceId)
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
