import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExecuteSqlToolHandler } from "./execute-sql.js";
import { createSearchDatabaseObjectsToolHandler, searchDatabaseObjectsSchema } from "./search-objects.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getToolMetadataForSource } from "../utils/tool-metadata.js";
import { normalizeSourceId } from "../utils/normalize-id.js";
import { customToolRegistry } from "./custom-tool-registry.js";
import { createCustomToolHandler, buildZodSchemaFromParameters } from "./custom-tool-handler.js";
import type { ToolConfig } from "../types/config.js";

/**
 * Register all tool handlers with the MCP server
 * Creates tools for each configured database source, plus custom tools from TOML
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
    const searchToolName = sourceId === "default" ? "search_objects" : `search_objects_${normalizeSourceId(sourceId)}`;
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

  // Register custom tools from TOML configuration
  // The registry was already initialized and validated by server.ts
  if (customToolRegistry.isInitialized()) {
    const validatedTools = customToolRegistry.getTools();

    console.error(`Registering ${validatedTools.length} custom tool(s) from configuration...`);

    for (const toolConfig of validatedTools) {
      const sourceConfig = ConnectorManager.getSourceConfig(toolConfig.source);
      const dbType = sourceConfig?.type || "database";

      // Determine if the tool is read-only based on its SQL statement
      const isReadOnly = (() => {
        const cleanedSQL = toolConfig.statement.trim().toLowerCase();
        const firstWord = cleanedSQL.split(/\s+/)[0];
        return ["select", "show", "describe", "explain", "with"].includes(firstWord);
      })();

      // Build Zod schema object (same format as built-in tools)
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
  }
}
