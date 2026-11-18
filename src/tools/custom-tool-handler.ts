/**
 * Custom Tool Handler
 * Creates MCP tool handlers for custom SQL-based tools defined in TOML config
 */

import { z } from "zod";
import { ToolConfig, ParameterConfig } from "../types/config.js";
import { mapArgumentsToArray } from "../utils/parameter-mapper.js";
import {
  createReadonlyViolationMessage,
  runToolRequest,
  ToolError,
  toStatementsPayload,
} from "../utils/tool-handler-helpers.js";
import { policyFromReadonly, isReadOnlyPolicy, sqlVerdict } from "../utils/sql-access-policy.js";

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
 * Wrapped input schema per tool config, cached by config object identity.
 * createServer() runs per HTTP request, and both registration and the handler
 * need the same schema — the cache means each ToolConfig's schema is built
 * once (hot reload produces new config objects, so stale entries just get
 * garbage collected).
 */
const customToolInputSchemas = new WeakMap<ToolConfig, z.ZodObject<Record<string, z.ZodTypeAny>>>();

export function getCustomToolInputSchema(toolConfig: ToolConfig): z.ZodObject<Record<string, z.ZodTypeAny>> {
  let schema = customToolInputSchemas.get(toolConfig);
  if (!schema) {
    schema = z.object(buildZodSchemaFromParameters(toolConfig.parameters));
    customToolInputSchemas.set(toolConfig, schema);
  }
  return schema;
}

/**
 * Create a custom tool handler for a user-defined SQL tool
 * @param toolConfig Tool configuration from TOML
 * @returns Handler function compatible with MCP server.registerTool
 */
export function createCustomToolHandler(toolConfig: ToolConfig) {
  // Same schema object the tool was registered with (cached per config)
  const zodSchema = getCustomToolInputSchema(toolConfig);

  return async (args: any, extra: any) => {
    let paramValues: any[] = [];

    return runToolRequest(
      {
        sourceId: toolConfig.source,
        toolName: toolConfig.name,
        sql: toolConfig.statement,
        extra,
        describeError: (error) => {
          // Provide helpful error messages for common issues
          const message =
            error instanceof z.ZodError
              ? `Parameter validation failed: ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
              : // Add SQL context to execution errors for debugging
                `${(error as Error).message}\n\nSQL: ${toolConfig.statement}\nParameters: ${JSON.stringify(paramValues)}`;
          return { message, code: "EXECUTION_ERROR", tracked: message };
        },
      },
      async (connect) => {
        // 1. Validate arguments against Zod schema, before any connection is opened
        const validatedArgs = zodSchema.parse(args);

        // 2. Connect to the tool's source (handles lazy connections)
        const connector = await connect();

        // 3. Build execute options from the tool's access policy (compiled
        // from the per-tool readonly config); the engine-level read-only
        // backstop derives from the same policy as the gate below.
        const policy = policyFromReadonly(toolConfig.readonly);
        const executeOptions = {
          readonly: isReadOnlyPolicy(policy),
          maxRows: toolConfig.max_rows,
        };

        // 4. Gate the statement through the policy
        if (sqlVerdict(policy, toolConfig.statement, connector.id) === "deny") {
          throw new ToolError(
            createReadonlyViolationMessage(toolConfig.name, toolConfig.source, connector.id),
            "READONLY_VIOLATION"
          );
        }

        // 5. Map parameters to array format for SQL execution
        paramValues = mapArgumentsToArray(toolConfig.parameters, validatedArgs);

        // 6. Execute SQL with parameters
        const result = await connector.executeSQL(toolConfig.statement, executeOptions, paramValues);

        // 7. A custom tool's statement is usually one SQL statement, but
        // isn't restricted to be - surface every statement's result rather
        // than assuming exactly one.
        return {
          statements: toStatementsPayload(result.resultSets),
          source_id: toolConfig.source,
        };
      }
    );
  };
}
