import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { bigIntReplacer, createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { allowedKeywords } from "../utils/allowed-keywords.js";
import { policyFromReadonly, isReadOnlyPolicy, sqlVerdict } from "../utils/sql-access-policy.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL } from "./builtin-tools.js";
import {
  getEffectiveSourceId,
  toStatementsPayload,
  trackToolRequest,
  tryClassifyConnectionError,
} from "../utils/tool-handler-helpers.js";

// Schema for execute_sql tool. The raw shape stays exported for consumers
// that iterate fields (zodToParameters); the wrapped object is built once at
// module scope because createServer() runs per HTTP request and registration
// converts the schema eagerly.
export const executeSqlSchema = {
  sql: z.string().describe("SQL to execute (multiple statements separated by ;)"),
};

export const executeSqlInputSchema = z.object(executeSqlSchema);

// Structured-output contract for the tool result: the MCP client renders this
// in code-mode catalogs, so it describes the actual response envelope (the
// `statements` payload built by the handler). Column metadata is present only
// when the connector could recover it from the driver.
export const executeSqlOutputSchema = z.object({
  statements: z.array(
    z.object({
      sql: z.string().optional(),
      columns: z
        .array(z.object({ name: z.string(), type: z.string() }))
        .optional(),
      rows: z.array(z.record(z.string(), z.unknown())),
      count: z.number(),
      truncated: z.boolean().optional(),
    })
  ),
  source_id: z.string(),
  messages: z.array(z.record(z.string(), z.unknown())).optional(),
});

/**
 * Create an execute_sql tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to (undefined for single-source mode)
 * @returns A handler function bound to the specified source
 */
export function createExecuteSqlToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { sql } = args as { sql: string };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;
    let result: any;

    try {
      // Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(sourceId);

      // Get connector for the specified source (or default)
      const connector = ConnectorManager.getCurrentConnector(sourceId);
      const actualSourceId = connector.getId();

      // Get tool-specific configuration (tool is already registered, so it's enabled)
      const registry = getToolRegistry();
      const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, actualSourceId);

      // Gate the SQL through the tool's access policy (compiled from the
      // per-tool readonly config; multi-statement input takes the strictest
      // statement's verdict)
      const policy = policyFromReadonly(toolConfig?.readonly);
      if (sqlVerdict(policy, sql, connector.id) === "deny") {
        errorMessage = `Read-only mode is enabled. Only the following SQL operations are allowed: ${allowedKeywords[connector.id]?.join(", ") || "none"}`;
        success = false;
        return createToolErrorResponse(errorMessage, "READONLY_VIOLATION");
      }

      // Execute the SQL (single or multiple statements) if validation passed.
      // The engine-level read-only backstop derives from the same policy.
      const executeOptions = {
        readonly: isReadOnlyPolicy(policy),
        maxRows: toolConfig?.max_rows,
      };
      result = await connector.executeSQL(sql, executeOptions);

      // Build response data. Every statement in the batch gets its own
      // entry - a single SELECT (the common case) is `statements` of length
      // 1, rather than rows from different statements being merged.
      const responseData = {
        statements: toStatementsPayload(result.resultSets),
        source_id: effectiveSourceId,
        ...(result.messages && result.messages.length > 0 ? { messages: result.messages } : {}),
      };

      // structuredContent carries the same payload in machine-readable form
      // for MCP clients that render tool output schemas (code-mode catalogs).
      return {
        ...createToolSuccessResponse(responseData),
        structuredContent: JSON.parse(JSON.stringify(responseData, bigIntReplacer)),
        isError: false as const,
      };
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      const classified = tryClassifyConnectionError(error, sourceId, effectiveSourceId);
      if (classified) return classified;
      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      // Track the request
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: effectiveSourceId === "default" ? "execute_sql" : `execute_sql_${effectiveSourceId}`,
          sql,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
