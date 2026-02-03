/**
 * Custom Tool Handler
 * Creates MCP tool handlers for custom SQL-based tools defined in TOML config
 */

import { z } from "zod";
import { ToolConfig, ParameterConfig } from "../types/config.js";
import { ConnectorManager } from "../connectors/manager.js";
import {
  createToolSuccessResponse,
  createToolErrorResponse,
} from "../utils/response-formatter.js";
import { mapArgumentsToArray } from "../utils/parameter-mapper.js";
import {
  isAllowedInReadonlyMode,
  createReadonlyViolationMessage,
  trackToolRequest,
} from "../utils/tool-handler-helpers.js";

/**
 * Build a Zod schema from parameter definitions
 * Returns a plain object with Zod schemas (MCP SDK format)
 * @param parameters Parameter configurations from TOML
 * @returns Plain object with Zod type definitions
 */
export function buildZodSchemaFromParameters(
  parameters: ParameterConfig[] | undefined
): Record<string, z.ZodTypeAny> {
  if (!parameters || parameters.length === 0) {
    return {};
  }

  const schemaShape: Record<string, z.ZodTypeAny> = {};

  for (const param of parameters) {
    let fieldSchema: z.ZodTypeAny;

    // Build base schema based on type
    switch (param.type) {
      case "string":
        fieldSchema = z.string().describe(param.description);
        break;
      case "integer":
        fieldSchema = z.number().int().describe(param.description);
        break;
      case "float":
        fieldSchema = z.number().describe(param.description);
        break;
      case "boolean":
        fieldSchema = z.boolean().describe(param.description);
        break;
      case "array":
        fieldSchema = z.array(z.unknown()).describe(param.description);
        break;
      default:
        throw new Error(`Unsupported parameter type: ${param.type}`);
    }

    // Add enum constraint if allowed_values is specified
    if (param.allowed_values && param.allowed_values.length > 0) {
      if (param.type === "string") {
        fieldSchema = z.enum(param.allowed_values as [string, ...string[]]).describe(param.description);
      } else {
        // For non-string types, use refine to validate against allowed values
        fieldSchema = fieldSchema.refine(
          (val) => param.allowed_values!.includes(val),
          {
            message: `Value must be one of: ${param.allowed_values.join(", ")}`,
          }
        );
      }
    }

    // Make field optional if it has a default value or is explicitly marked as not required
    if (param.default !== undefined || param.required === false) {
      fieldSchema = fieldSchema.optional();
    }

    schemaShape[param.name] = fieldSchema;
  }

  return schemaShape;
}

/**
 * Build input schema in MCP format (JSON Schema compatible)
 * @param parameters Parameter configurations from TOML
 * @returns JSON Schema object
 */
export function buildInputSchema(parameters: ParameterConfig[] | undefined): {
  type: "object";
  properties: Record<string, any>;
  required?: string[];
} {
  // Convert Zod schema to JSON Schema-like format for MCP
  const properties: Record<string, any> = {};
  const required: string[] = [];

  if (parameters) {
    for (const param of parameters) {
      const propSchema: any = {
        description: param.description,
      };

      // Map type to JSON Schema type
      switch (param.type) {
        case "string":
          propSchema.type = "string";
          break;
        case "integer":
          propSchema.type = "integer";
          break;
        case "float":
          propSchema.type = "number";
          break;
        case "boolean":
          propSchema.type = "boolean";
          break;
        case "array":
          propSchema.type = "array";
          break;
      }

      // Add enum if allowed_values specified
      if (param.allowed_values && param.allowed_values.length > 0) {
        propSchema.enum = param.allowed_values;
      }

      properties[param.name] = propSchema;

      // Track required fields
      if (param.required !== false && param.default === undefined) {
        required.push(param.name);
      }
    }
  }

  const schema: any = {
    type: "object",
    properties,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

/**
 * Create a custom tool handler for a user-defined SQL tool
 * @param toolConfig Tool configuration from TOML
 * @returns Handler function compatible with MCP server.registerTool
 */
export function createCustomToolHandler(toolConfig: ToolConfig) {
  // Build Zod schema shape for MCP registration
  const zodSchemaShape = buildZodSchemaFromParameters(toolConfig.parameters);
  // Wrap in z.object() for validation
  const zodSchema = z.object(zodSchemaShape);

  return async (args: any, extra: any) => {
    const startTime = Date.now();
    let success = true;
    let errorMessage: string | undefined;
    let paramValues: any[] = [];

    try {
      // 1. Validate arguments against Zod schema
      const validatedArgs = zodSchema.parse(args);

      // 2. Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(toolConfig.source);

      // 3. Get connector for the specified source
      const connector = ConnectorManager.getCurrentConnector(toolConfig.source);

      // 4. Build execute options from tool configuration
      const executeOptions = {
        readonly: toolConfig.readonly,
        maxRows: toolConfig.max_rows,
      };

      // 5. Check if SQL is allowed based on readonly mode
      const isReadonly = executeOptions.readonly === true;
      if (isReadonly && !isAllowedInReadonlyMode(toolConfig.statement, connector.id)) {
        errorMessage = createReadonlyViolationMessage(toolConfig.name, toolConfig.source, connector.id);
        success = false;
        return createToolErrorResponse(errorMessage, "READONLY_VIOLATION");
      }

      // 6. Map parameters to array format for SQL execution
      paramValues = mapArgumentsToArray(
        toolConfig.parameters,
        validatedArgs
      );

      // 7. Execute SQL with parameters
      const result = await connector.executeSQL(
        toolConfig.statement,
        executeOptions,
        paramValues
      );

      // 8. Build response data
      const responseData = {
        rows: result.rows,
        count: result.rowCount,
        source_id: toolConfig.source,
      };

      return createToolSuccessResponse(responseData);
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;

      // Provide helpful error messages for common issues
      if (error instanceof z.ZodError) {
        const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        errorMessage = `Parameter validation failed: ${issues}`;
      } else {
        // Add SQL context to execution errors for debugging
        errorMessage = `${errorMessage}\n\nSQL: ${toolConfig.statement}\nParameters: ${JSON.stringify(paramValues)}`;
      }

      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      // Track the request
      trackToolRequest(
        {
          sourceId: toolConfig.source,
          toolName: toolConfig.name,
          sql: toolConfig.statement,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
