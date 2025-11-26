import { z } from "zod";
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
    const required = !zodType.isOptional();

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
  const dbType = sourceConfig?.type || "database";

  // Determine tool name based on single vs multi-source configuration
  let toolName: string;
  if (sourceIds.length === 1) {
    // Single source: use "execute_sql" if ID is empty, otherwise suffix with ID
    toolName = sourceId === "" ? "execute_sql" : `execute_sql_${normalizeSourceId(sourceId)}`;
  } else {
    // Multiple sources: always suffix with source ID
    toolName = `execute_sql_${normalizeSourceId(sourceId)}`;
  }

  // Determine description
  const isDefault = sourceIds[0] === sourceId;
  const description = `Execute a SQL query on the '${sourceId}' ${dbType} database${isDefault ? " (default)" : ""}`;

  return {
    name: toolName,
    description,
    schema: executeSqlSchema,
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
