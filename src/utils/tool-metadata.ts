import { z } from "zod";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorManager } from "../connectors/manager.js";
import { normalizeSourceId } from "./normalize-id.js";
import { executeSqlSchema, executeSqlMultiSourceSchema } from "../tools/execute-sql.js";
import { searchDatabaseObjectsSchema, searchDatabaseObjectsMultiSourceSchema } from "../tools/search-objects.js";
import { getToolRegistry } from "../tools/registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL } from "../tools/builtin-tools.js";
import type { ParameterConfig, ToolConfig } from "../types/config.js";

/**
 * Tool parameter definition for API responses
 */
export interface ToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/**
 * Tool metadata for API responses
 */
export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  statement?: string;
  readonly?: boolean;
  max_rows?: number;
}

/**
 * Tool metadata with Zod schema (used internally for registration)
 */
export interface ToolMetadata {
  name: string;
  description: string;
  schema: Record<string, z.ZodType<any>>;
  annotations: ToolAnnotations;
}

/**
 * Convert a Zod schema object to simplified parameter list
 * @param schema - Zod schema object (e.g., { sql: z.string().describe("...") })
 * @returns Array of tool parameters
 */
export function zodToParameters(schema: Record<string, z.ZodType<any>>): ToolParameter[] {
  const parameters: ToolParameter[] = [];

  for (const [key, zodType] of Object.entries(schema)) {
    // Extract description from Zod schema
    const description = zodType.description || "";

    // Determine if required (Zod types are required by default unless optional)
    const required = !(zodType instanceof z.ZodOptional);

    // Determine type from Zod type
    let type = "string"; // default
    if (zodType instanceof z.ZodString) {
      type = "string";
    } else if (zodType instanceof z.ZodNumber) {
      type = "number";
    } else if (zodType instanceof z.ZodBoolean) {
      type = "boolean";
    } else if (zodType instanceof z.ZodArray) {
      type = "array";
    } else if (zodType instanceof z.ZodObject) {
      type = "object";
    }

    parameters.push({
      name: key,
      type,
      required,
      description,
    });
  }

  return parameters;
}

/**
 * Get execute_sql tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool metadata with name, description, and Zod schema
 */
export function getExecuteSqlMetadata(sourceId?: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const isSingleSource = sourceIds.length === 1;

  // Multi-source generic mode: no sourceId means register a single generic tool
  if (!isSingleSource && sourceId === undefined) {
    return {
      name: "execute_sql",
      description: "Execute SQL queries on a database source. Use list_sources to discover available source IDs, then pass source_id.",
      schema: executeSqlMultiSourceSchema,
      annotations: {
        title: "Execute SQL",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    };
  }

  const effectiveSourceId = sourceId ?? sourceIds[0];
  const sourceConfig = ConnectorManager.getSourceConfig(effectiveSourceId)!;
  const dbType = sourceConfig.type;

  // Get tool configuration from registry to extract readonly/max_rows
  const registry = getToolRegistry();
  const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, effectiveSourceId);
  const executeOptions = {
    readonly: toolConfig?.readonly,
    maxRows: toolConfig?.max_rows,
  };

  // Determine tool name based on single vs multi-source configuration
  const toolName = isSingleSource ? "execute_sql" : `execute_sql_${normalizeSourceId(effectiveSourceId)}`;

  // Determine title (human-readable display name)
  const title = isSingleSource
    ? `Execute SQL (${dbType})`
    : `Execute SQL on ${effectiveSourceId} (${dbType})`;

  // Determine description with more context
  const readonlyNote = executeOptions.readonly ? " [READ-ONLY MODE]" : "";
  const maxRowsNote = executeOptions.maxRows ? ` (limited to ${executeOptions.maxRows} rows)` : "";
  const description = isSingleSource
    ? `Execute SQL queries on the ${dbType} database${readonlyNote}${maxRowsNote}`
    : `Execute SQL queries on the '${effectiveSourceId}' ${dbType} database${readonlyNote}${maxRowsNote}`;

  // Build annotations object with all standard MCP hints
  const isReadonly = executeOptions.readonly === true;
  const annotations = {
    title,
    readOnlyHint: isReadonly,
    destructiveHint: !isReadonly, // Can be destructive if not readonly
    // In readonly mode, queries are more predictable (though still not strictly idempotent due to data changes)
    // In write mode, queries are definitely not idempotent
    idempotentHint: false,
    // Database operations are always against internal/closed systems, not open-world
    openWorldHint: false,
  };

  return {
    name: toolName,
    description,
    schema: executeSqlSchema,
    annotations,
  };
}

/**
 * Get search_objects tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool metadata with name, description, schema, and annotations
 */
export function getSearchObjectsMetadata(sourceId?: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const isSingleSource = sourceIds.length === 1;

  // Multi-source generic mode: no sourceId means register a single generic tool
  if (!isSingleSource && sourceId === undefined) {
    return {
      name: "search_objects",
      description: "Search and list database objects (schemas, tables, columns, procedures, functions, indexes). Use list_sources to discover source IDs, then pass source_id.",
      schema: searchDatabaseObjectsMultiSourceSchema,
      annotations: {
        title: "Search Database Objects",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    };
  }

  const effectiveSourceId = sourceId ?? sourceIds[0];
  const sourceConfig = ConnectorManager.getSourceConfig(effectiveSourceId)!;
  const dbType = sourceConfig.type;

  const toolName = isSingleSource ? "search_objects" : `search_objects_${normalizeSourceId(effectiveSourceId)}`;
  const title = isSingleSource
    ? `Search Database Objects (${dbType})`
    : `Search Database Objects on ${effectiveSourceId} (${dbType})`;
  const description = isSingleSource
    ? `Search and list database objects (schemas, tables, columns, procedures, functions, indexes) on the ${dbType} database`
    : `Search and list database objects (schemas, tables, columns, procedures, functions, indexes) on the '${effectiveSourceId}' ${dbType} database`;

  return {
    name: toolName,
    description,
    schema: searchDatabaseObjectsSchema,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
}

/**
 * Convert custom tool parameter configs to Tool parameter format
 * @param params - Parameter configurations from custom tool
 * @returns Array of tool parameters
 */
function customParamsToToolParams(params: ParameterConfig[] | undefined): ToolParameter[] {
  if (!params || params.length === 0) {
    return [];
  }

  return params.map((param) => ({
    name: param.name,
    type: param.type,
    required: param.required !== false && param.default === undefined,
    description: param.description,
  }));
}

/**
 * Build execute_sql tool metadata for API response
 */
function buildExecuteSqlTool(sourceId: string, toolConfig?: ToolConfig): Tool {
  const executeSqlMetadata = getExecuteSqlMetadata(sourceId);
  const executeSqlParameters = zodToParameters(executeSqlMetadata.schema);

  // Extract readonly and max_rows from toolConfig
  // ToolConfig is a union type, but ExecuteSqlToolConfig and CustomToolConfig both have these fields
  const readonly = toolConfig && 'readonly' in toolConfig ? toolConfig.readonly : undefined;
  const max_rows = toolConfig && 'max_rows' in toolConfig ? toolConfig.max_rows : undefined;

  return {
    name: executeSqlMetadata.name,
    description: executeSqlMetadata.description,
    parameters: executeSqlParameters,
    readonly,
    max_rows,
  };
}

/**
 * Build search_objects tool metadata for API response
 */
function buildSearchObjectsTool(sourceId: string): Tool {
  const searchMetadata = getSearchObjectsMetadata(sourceId);

  return {
    name: searchMetadata.name,
    description: searchMetadata.description,
    parameters: [
      {
        name: "object_type",
        type: "string",
        required: true,
        description: "Object type to search",
      },
      {
        name: "pattern",
        type: "string",
        required: false,
        description: "LIKE pattern (% = any chars, _ = one char). Default: %",
      },
      {
        name: "schema",
        type: "string",
        required: false,
        description: "Filter to schema",
      },
      {
        name: "table",
        type: "string",
        required: false,
        description: "Filter to table (requires schema; column/index only)",
      },
      {
        name: "detail_level",
        type: "string",
        required: false,
        description: "Detail: names (minimal), summary (metadata), full (all)",
      },
      {
        name: "limit",
        type: "integer",
        required: false,
        description: "Max results (default: 100, max: 1000)",
      },
    ],
    readonly: true, // search_objects is always readonly
  };
}

/**
 * Build custom tool metadata for API response
 */
function buildCustomTool(toolConfig: ToolConfig): Tool {
  return {
    name: toolConfig.name,
    description: toolConfig.description!,
    parameters: customParamsToToolParams(toolConfig.parameters),
    statement: toolConfig.statement,
    readonly: toolConfig.readonly,
    max_rows: toolConfig.max_rows,
  };
}

/**
 * Get tools for a specific source (API response format)
 * Only includes tools that are actually enabled in the ToolRegistry
 * @param sourceId - The source ID to get tools for
 * @returns Array of enabled tools with simplified parameters
 */
export function getToolsForSource(sourceId: string): Tool[] {
  // Get enabled tools from registry
  const registry = getToolRegistry();
  const enabledToolConfigs = registry.getEnabledToolConfigs(sourceId);

  // Uniform iteration: map each enabled tool config to its API representation
  return enabledToolConfigs.map((toolConfig) => {
    // Dispatch based on tool name
    if (toolConfig.name === "execute_sql") {
      return buildExecuteSqlTool(sourceId, toolConfig);
    } else if (toolConfig.name === "search_objects") {
      return buildSearchObjectsTool(sourceId);
    } else {
      // Custom tool
      return buildCustomTool(toolConfig);
    }
  });
}
