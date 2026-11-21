import { z } from "zod";
import { allowedKeywords } from "../utils/allowed-keywords.js";
import { policyFromReadonly, isReadOnlyPolicy, sqlVerdict } from "../utils/sql-access-policy.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL } from "./builtin-tools.js";
import {
  resolveTrackedToolName,
  runToolRequest,
  ToolError,
  toStatementsPayload,
  unparsedSQLReason,
} from "../utils/tool-handler-helpers.js";

// Schema for execute_sql tool. The raw shape stays exported for consumers
// that iterate fields (zodToParameters); the wrapped object is built once at
// module scope because createServer() runs per HTTP request and registration
// converts the schema eagerly.
export const executeSqlSchema = {
  sql: z.string().describe("SQL to execute (multiple statements separated by ;)"),
};

export const executeSqlInputSchema = z.object(executeSqlSchema);

/**
 * Create an execute_sql tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to (undefined for single-source mode)
 * @returns A handler function bound to the specified source
 */
export function createExecuteSqlToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { sql } = args as { sql: string };

    return runToolRequest(
      {
        sourceId,
        toolName: resolveTrackedToolName(sourceId, BUILTIN_TOOL_EXECUTE_SQL),
        sql,
        extra,
      },
      async (connect, effectiveSourceId) => {
        const connector = await connect();
        const actualSourceId = connector.getId();

        // Get tool-specific configuration (tool is already registered, so it's enabled)
        const registry = getToolRegistry();
        const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, actualSourceId);

        // Gate the SQL through the tool's access policy (compiled from the
        // per-tool readonly config; multi-statement input takes the strictest
        // statement's verdict)
        const policy = policyFromReadonly(toolConfig?.readonly);
        if (sqlVerdict(policy, sql, connector.id) === "deny") {
          // SQL the parser cannot read is refused too; say so, or a typo reads
          // as a blocked write.
          const unparsed = unparsedSQLReason(sql, connector.id);
          throw new ToolError(
            unparsed
              ? `Read-only mode is enabled, and this SQL could not be parsed as PostgreSQL, so it was not run: ${unparsed}`
              : `Read-only mode is enabled. Only the following SQL operations are allowed: ${allowedKeywords[connector.id]?.join(", ") || "none"}`,
            "READONLY_VIOLATION"
          );
        }

        // Execute the SQL (single or multiple statements) if validation passed.
        // The engine-level read-only backstop derives from the same policy.
        const result = await connector.executeSQL(sql, {
          readonly: isReadOnlyPolicy(policy),
          maxRows: toolConfig?.max_rows,
        });

        // Every statement in the batch gets its own entry - a single SELECT
        // (the common case) is `statements` of length 1, rather than rows
        // from different statements being merged.
        return {
          statements: toStatementsPayload(result.resultSets),
          source_id: effectiveSourceId,
          ...(result.messages && result.messages.length > 0 ? { messages: result.messages } : {}),
        };
      }
    );
  };
}
