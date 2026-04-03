import { z } from "zod";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorManager } from "../connectors/manager.js";
import { executeSqlSchema, executeSqlMultiSourceSchema } from "../tools/execute-sql.js";
import {
  searchDatabaseObjectsSchema,
  searchDatabaseObjectsMultiSourceSchema,
} from "../tools/search-objects.js";
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
    // Read description from the outermost type before unwrapping
    const description = zodType.description || "";

    let innerType = zodType;
    let required = true;

    // Unwrap ZodDefault/ZodOptional
    if (innerType instanceof z.ZodDefault) {
      required = false;
      innerType = (innerType as z.ZodDefault<any>)._def.innerType;
    }

    if (innerType instanceof z.ZodOptional) {
      required = false;
      innerType = (innerType as z.ZodOptional<any>).unwrap();
    }

    // Determine type from unwrapped inner type
    let type = "string";

    if (innerType instanceof z.ZodString) {
      type = "string";
    } else if (innerType instanceof z.ZodNumber) {
      type = "number";
    } else if (innerType instanceof z.ZodBoolean) {
      type = "boolean";
    } else if (innerType instanceof z.ZodArray) {
      type = "array";
    } else if (innerType instanceof z.ZodObject) {
      type = "object";
    } else if (innerType instanceof z.ZodEnum) {
      type = "string";
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
 * @param boundSourceId - The source ID this metadata is bound to (undefined for multi-source mode)
 * @returns Tool metadata with name, description, and Zod schema
 */
export function getExecuteSqlMetadata(boundSourceId?: string): ToolMetadata {
  if (boundSourceId === undefined) {
    return {
      name: "execute_sql",
      description:
        "Execute SQL queries on a database source. Use list_sources to discover available source IDs, then pass source_id.",
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

  const sourceConfig = ConnectorManager.getSourceConfig(boundSourceId)!;
  const dbType = sourceConfig.type;

  const registry = getToolRegistry();
  const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, boundSourceId);
  const isReadonly = toolConfig?.readonly === true;
  const maxRows = toolConfig?.max_rows;

  const readonlyNote = isReadonly ? " [READ-ONLY MODE]" : "";
  const maxRowsNote = maxRows ? ` (limited to ${maxRows} rows)` : "";

  return {
    name: "execute_sql",
    description: `Execute SQL queries on the '${boundSourceId}' ${dbType} database${readonlyNote}${maxRowsNote}`,
    schema: executeSqlSchema,
    annotations: {
      title: `Execute SQL - ${boundSourceId} (${dbType})`,
      readOnlyHint: isReadonly,
      destructiveHint: !isReadonly,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

/**
 * Get search_objects tool metadata for a specific source
 * @param boundSourceId - The source ID this metadata is bound to (undefined for multi-source mode)
 * @returns Tool metadata with name, description, schema, and annotations
 */
export function getSearchObjectsMetadata(boundSourceId?: string): ToolMetadata {
  if (boundSourceId === undefined) {
    return {
      name: "search_objects",
      description:
        "Search and list database objects (schemas, tables, columns, procedures, functions, indexes). Use list_sources to discover source IDs, then pass source_id.",
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

  const sourceConfig = ConnectorManager.getSourceConfig(boundSourceId)!;
  const dbType = sourceConfig.type;

  return {
    name: "search_objects",
    description: `Search and list database objects (schemas, tables, columns, procedures, functions, indexes) on the '${boundSourceId}' ${dbType} database`,
    schema: searchDatabaseObjectsSchema,
    annotations: {
      title: `Search Database Objects - ${boundSourceId} (${dbType})`,
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
function buildExecuteSqlTool(boundSourceId?: string, toolConfig?: ToolConfig): Tool {
  const executeSqlMetadata = getExecuteSqlMetadata(boundSourceId);
  const executeSqlParameters = zodToParameters(executeSqlMetadata.schema);

  // Extract readonly and max_rows from toolConfig
  // ToolConfig is a union type, but ExecuteSqlToolConfig and CustomToolConfig both have these fields
  const readonly = toolConfig && "readonly" in toolConfig ? toolConfig.readonly : undefined;
  const max_rows = toolConfig && "max_rows" in toolConfig ? toolConfig.max_rows : undefined;

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
function buildSearchObjectsTool(boundSourceId?: string): Tool {
  const searchMetadata = getSearchObjectsMetadata(boundSourceId);

  return {
    name: searchMetadata.name,
    description: searchMetadata.description,
    parameters: zodToParameters(searchMetadata.schema),
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
  const isSingleSource = ConnectorManager.getAvailableSourceIds().length === 1;

  // Uniform iteration: map each enabled tool config to its API representation
  return enabledToolConfigs.map((toolConfig) => {
    // Dispatch based on tool name
    if (toolConfig.name === "execute_sql") {
      // In multi-source mode, use generic metadata (undefined = generic tool with source_id param)
      return buildExecuteSqlTool(isSingleSource ? sourceId : undefined, toolConfig);
    } else if (toolConfig.name === "search_objects") {
      return buildSearchObjectsTool(isSingleSource ? sourceId : undefined);
    } else {
      // Custom tool
      return buildCustomTool(toolConfig);
    }
  });
}
