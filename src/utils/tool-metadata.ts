import { z } from "zod";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ConnectorManager } from "../connectors/manager.js";
import { normalizeSourceId } from "./normalize-id.js";
import { executeSqlSchema } from "../tools/execute-sql.js";

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
 * Get tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool metadata with name, description, and Zod schema
 */
export function getToolMetadataForSource(sourceId: string): ToolMetadata {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId);
  const executeOptions = ConnectorManager.getCurrentExecuteOptions(sourceId);
  const dbType = sourceConfig?.type || "database";

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
    // In readonly mode, it's safer to operate on arbitrary tables (just reading)
    // In write mode, operating on arbitrary tables is more dangerous
    openWorldHint: isReadonly,
  };

  return {
    name: toolName,
    description,
    schema: executeSqlSchema,
    annotations,
  };
}

/**
 * Get tools for a specific source (API response format)
 * @param sourceId - The source ID to get tools for
 * @returns Array of tools with simplified parameters
 */
export function getToolsForSource(sourceId: string): Tool[] {
  const metadata = getToolMetadataForSource(sourceId);
  const parameters = zodToParameters(metadata.schema);

  return [
    {
      name: metadata.name,
      description: metadata.description,
      parameters,
    },
  ];
}
