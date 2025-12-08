import { z } from "zod";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorManager } from "../connectors/manager.js";
import { normalizeSourceId } from "./normalize-id.js";
import { executeSqlSchema } from "../tools/execute-sql.js";
import { customToolRegistry } from "../tools/custom-tool-registry.js";
import type { ParameterConfig } from "../types/config.js";

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
export function getExecuteSqlMetadata(sourceId: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const executeOptions = ConnectorManager.getCurrentExecuteOptions(sourceId);
  const dbType = sourceConfig.type;

  // Determine tool name based on single vs multi-source configuration
  const toolName = sourceId === "default" ? "execute_sql" : `execute_sql_${normalizeSourceId(sourceId)}`;

  // Determine title (human-readable display name)
  const isDefault = sourceIds[0] === sourceId;
  const title = isDefault
    ? `Execute SQL (${dbType})`
    : `Execute SQL on ${sourceId} (${dbType})`;

  // Determine description with more context
  const readonlyNote = executeOptions.readonly ? " [READ-ONLY MODE]" : "";
  const maxRowsNote = executeOptions.maxRows ? ` (limited to ${executeOptions.maxRows} rows)` : "";
  const description = `Execute SQL queries on the '${sourceId}' ${dbType} database${isDefault ? " (default)" : ""}${readonlyNote}${maxRowsNote}`;

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
 * @param dbType - Database type
 * @param isDefault - Whether this is the default source
 * @returns Tool name, description, and annotations
 */
export function getSearchObjectsMetadata(
  sourceId: string,
  dbType: string,
  isDefault: boolean
): { name: string; description: string; title: string } {
  const toolName = sourceId === "default" ? "search_objects" : `search_objects_${normalizeSourceId(sourceId)}`;
  const title = isDefault
    ? `Search Database Objects (${dbType})`
    : `Search Database Objects on ${sourceId} (${dbType})`;
  const description = `Search and list database objects (schemas, tables, columns, procedures, indexes) on the '${sourceId}' ${dbType} database${isDefault ? " (default)" : ""}. Supports SQL LIKE patterns (default: '%' for all), filtering, and token-efficient progressive disclosure.`;

  return {
    name: toolName,
    description,
    title,
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
 * Get tools for a specific source (API response format)
 * Includes both built-in tools (execute_sql, search_objects) and custom tools
 * @param sourceId - The source ID to get tools for
 * @returns Array of tools with simplified parameters
 */
export function getToolsForSource(sourceId: string): Tool[] {
  const tools: Tool[] = [];
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const isDefault = sourceIds[0] === sourceId;

  // 1. Add built-in execute_sql tool
  const executeSqlMetadata = getExecuteSqlMetadata(sourceId);
  const executeSqlParameters = zodToParameters(executeSqlMetadata.schema);
  tools.push({
    name: executeSqlMetadata.name,
    description: executeSqlMetadata.description,
    parameters: executeSqlParameters,
  });

  // 2. Add built-in search_objects tool
  const searchMetadata = getSearchObjectsMetadata(sourceId, dbType, isDefault);
  tools.push({
    name: searchMetadata.name,
    description: searchMetadata.description,
    parameters: [
      {
        name: "object_type",
        type: "string",
        required: true,
        description: "Type of database object to search for (schema, table, column, procedure, index)",
      },
      {
        name: "pattern",
        type: "string",
        required: false,
        description: "Search pattern (SQL LIKE syntax: % for wildcard, _ for single char). Case-insensitive. Defaults to '%' (match all).",
      },
      {
        name: "schema",
        type: "string",
        required: false,
        description: "Filter results to a specific schema/database",
      },
      {
        name: "detail_level",
        type: "string",
        required: false,
        description: "Level of detail to return: names (minimal), summary (with metadata), full (complete structure). Defaults to 'names'.",
      },
      {
        name: "limit",
        type: "integer",
        required: false,
        description: "Maximum number of results to return (default: 100, max: 1000)",
      },
    ],
  });

  // 3. Add custom tools for this source
  if (customToolRegistry.isInitialized()) {
    const customTools = customToolRegistry.getTools();
    const sourceCustomTools = customTools.filter((tool) => tool.source === sourceId);

    for (const customTool of sourceCustomTools) {
      tools.push({
        name: customTool.name,
        description: customTool.description,
        parameters: customParamsToToolParams(customTool.parameters),
      });
    }
  }

  return tools;
}
