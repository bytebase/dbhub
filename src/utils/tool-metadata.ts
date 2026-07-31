import { z } from "zod";
import { ToolAnnotations } from "@modelcontextprotocol/server";
import { policyFromReadonly, isReadOnlyPolicy } from "./sql-access-policy.js";
import { ConnectorManager } from "../connectors/manager.js";
import { normalizeSourceId } from "./normalize-id.js";
import { executeSqlSchema } from "../tools/execute-sql.js";
import { explainSqlSchema } from "../tools/explain-sql.js";
import { healthCheckSchema } from "../tools/health-check.js";
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
 * Build a prefix string for prepending a source's user-provided `description`
 * onto a generated tool description. Returns "" when no description is set
 * (undefined, empty, or whitespace-only). Normalizes surrounding whitespace
 * with `trim()` and skips adding a period when the description already ends
 * with one of "." / "!" / "?" / ":" — the colon is included because a
 * trailing colon naturally introduces what follows (the generic tool
 * template) and appending "." after it would produce artifacts like
 * "Details below:. Execute SQL...".
 *
 * Examples:
 *   undefined            -> ""
 *   "  "                 -> ""
 *   "Prod DB"            -> "Prod DB. "
 *   "Prod DB."           -> "Prod DB. "      (no double period)
 *   "  Prod DB!  "       -> "Prod DB! "      (trimmed, no added period)
 *   "Query me?"          -> "Query me? "
 *   "Details below:"     -> "Details below: " (colon introduces what follows)
 *   "Clause 1; clause 2" -> "Clause 1; clause 2. " (semicolon is mid-sentence)
 *   "(read-only)"        -> "(read-only). "  (closing paren is mid-sentence)
 */
export function buildSourceDescriptionPrefix(description: string | undefined): string {
  const trimmed = description?.trim() ?? "";
  if (!trimmed) return "";
  return /[.!?:]$/.test(trimmed) ? `${trimmed} ` : `${trimmed}. `;
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
 * Shared per-source naming for built-in tools: single-source deployments keep
 * the bare tool name, multi-source ones suffix with the normalized source id
 * (see CLAUDE.md's "Tool Handlers" section). Also resolves the source's db
 * type and the user-provided `description` prefix so callers only need to
 * supply the tool-specific label and body text.
 */
function resolveBuiltinToolNaming(sourceId: string, baseName: string, titleLabel: string) {
  const sourceIds = ConnectorManager.getAvailableSourceIds();
  const sourceConfig = ConnectorManager.getSourceConfig(sourceId)!;
  const dbType = sourceConfig.type;
  const isSingleSource = sourceIds.length === 1;

  const name = isSingleSource ? baseName : `${baseName}_${normalizeSourceId(sourceId)}`;
  const title = isSingleSource
    ? `${titleLabel} (${dbType})`
    : `${titleLabel} on ${sourceId} (${dbType})`;
  // Prepend the user-provided `description` from the source config (if set)
  // so AI clients reading the MCP tool list see the source's purpose first.
  const userDescPrefix = buildSourceDescriptionPrefix(sourceConfig.description);

  return { dbType, isSingleSource, name, title, userDescPrefix };
}

/**
 * Get execute_sql tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool metadata with name, description, and Zod schema
 */
export function getExecuteSqlMetadata(sourceId: string): ToolMetadata {
  const { dbType, isSingleSource, name, title, userDescPrefix } = resolveBuiltinToolNaming(
    sourceId,
    "execute_sql",
    "Execute SQL"
  );

  // Get tool configuration from registry to extract readonly/max_rows
  const registry = getToolRegistry();
  const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, sourceId);
  const executeOptions = {
    readonly: toolConfig?.readonly,
    maxRows: toolConfig?.max_rows,
  };

  const readonlyNote = executeOptions.readonly ? " [READ-ONLY MODE]" : "";
  const maxRowsNote = executeOptions.maxRows ? ` (limited to ${executeOptions.maxRows} rows)` : "";
  const description = isSingleSource
    ? `${userDescPrefix}Execute SQL queries on the ${dbType} database${readonlyNote}${maxRowsNote}`
    : `${userDescPrefix}Execute SQL queries on the '${sourceId}' ${dbType} database${readonlyNote}${maxRowsNote}`;

  // Build annotations object with all standard MCP hints, derived from the
  // same access policy that gates execution (see sql-access-policy.ts)
  const isReadonly = isReadOnlyPolicy(policyFromReadonly(executeOptions.readonly));
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
    name,
    description,
    schema: executeSqlSchema,
    annotations,
  };
}

/**
 * Get search_objects tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool name, description, and annotations
 */
export function getSearchObjectsMetadata(sourceId: string): { name: string; description: string; title: string } {
  const { dbType, isSingleSource, name, title, userDescPrefix } = resolveBuiltinToolNaming(
    sourceId,
    "search_objects",
    "Search Database Objects"
  );

  const description = isSingleSource
    ? `${userDescPrefix}Search and list database objects on the ${dbType} database`
    : `${userDescPrefix}Search and list database objects on the '${sourceId}' ${dbType} database`;

  return { name, description, title };
}

/**
 * Get explain_sql tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool metadata with name, description, and Zod schema
 */
export function getExplainSqlMetadata(sourceId: string): ToolMetadata {
  const { dbType, isSingleSource, name, title, userDescPrefix } = resolveBuiltinToolNaming(
    sourceId,
    "explain_sql",
    "Explain Query Plan"
  );

  const description = isSingleSource
    ? `${userDescPrefix}Show the execution plan for a SQL statement on the ${dbType} database without running it. Always read-only and safe, independent of the source's read/write mode.`
    : `${userDescPrefix}Show the execution plan for a SQL statement on the '${sourceId}' ${dbType} database without running it. Always read-only and safe, independent of the source's read/write mode.`;

  const annotations = {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  return {
    name,
    description,
    schema: explainSqlSchema,
    annotations,
  };
}

/**
 * Get health_check tool metadata for a specific source
 * @param sourceId - The source ID to get tool metadata for
 * @returns Tool metadata with name, description, and Zod schema
 */
export function getHealthCheckMetadata(sourceId: string): ToolMetadata {
  const { dbType, isSingleSource, name, title, userDescPrefix } = resolveBuiltinToolNaming(
    sourceId,
    "health_check",
    "Health Check"
  );

  const description = isSingleSource
    ? `${userDescPrefix}Report operational health metrics (connection pool state, buffer cache hit ratio) for the ${dbType} database. Read-only, independent of the source's read/write mode.`
    : `${userDescPrefix}Report operational health metrics (connection pool state, buffer cache hit ratio) for the '${sourceId}' ${dbType} database. Read-only, independent of the source's read/write mode.`;

  const annotations = {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false, // Metrics change from call to call, unlike explain_sql's plan output
    openWorldHint: false,
  };

  return {
    name,
    description,
    schema: healthCheckSchema,
    annotations,
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
        description: "Object type to search: schema, table, view, column, procedure, function, index",
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
 * Build explain_sql tool metadata for API response
 */
function buildExplainSqlTool(sourceId: string): Tool {
  const explainMetadata = getExplainSqlMetadata(sourceId);

  return {
    name: explainMetadata.name,
    description: explainMetadata.description,
    parameters: zodToParameters(explainMetadata.schema),
    readonly: true, // explain_sql is always readonly
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
    } else if (toolConfig.name === "explain_sql") {
      return buildExplainSqlTool(sourceId);
    } else {
      // Custom tool
      return buildCustomTool(toolConfig);
    }
  });
}
