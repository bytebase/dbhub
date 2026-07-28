import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse } from "../utils/response-formatter.js";
import { areAllStatementsReadOnly } from "../utils/allowed-keywords.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL } from "./builtin-tools.js";
import {
  getEffectiveSourceId,
  createReadonlyViolationMessage,
  trackToolRequest,
  tryClassifyConnectionError,
} from "../utils/tool-handler-helpers.js";
import {
  createGenericExecutionErrorView,
  createSafeToolErrorView,
  tryCreateSafeExecutionErrorView,
} from "../utils/safe-execution-error.js";

// Schema for execute_sql tool
export const executeSqlSchema = {
  sql: z.string().describe("SQL to execute (multiple statements separated by ;)"),
};

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
    let requestStoreError: string | undefined;
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

      // Check if SQL is allowed based on readonly mode (per-tool)
      const isReadonly = toolConfig?.readonly === true;
      if (isReadonly && !areAllStatementsReadOnly(sql, connector.id)) {
        success = false;
        const view = createSafeToolErrorView(
          "READONLY_VIOLATION",
          createReadonlyViolationMessage("execute_sql", effectiveSourceId, connector.id)
        );
        requestStoreError = view.requestStoreError;
        return view.response;
      }

      // Execute the SQL (single or multiple statements) if validation passed
      // Pass readonly and maxRows from tool config (if set)
      const executeOptions = {
        readonly: toolConfig?.readonly,
        maxRows: toolConfig?.max_rows,
      };
      result = await connector.executeSQL(sql, executeOptions);

      // Build response data
      const responseData = {
        rows: result.rows,
        count: result.rowCount,
        source_id: effectiveSourceId,
        ...(result.messages && result.messages.length > 0 ? { messages: result.messages } : {}),
      };

      return createToolSuccessResponse(responseData);
    } catch (error) {
      success = false;
      const safeExecutionView = tryCreateSafeExecutionErrorView(error);
      if (safeExecutionView) {
        requestStoreError = safeExecutionView.requestStoreError;
        return safeExecutionView.response;
      }
      const classified = tryClassifyConnectionError(error, sourceId, effectiveSourceId);
      if (classified) {
        requestStoreError = classified.requestStoreError;
        return classified.response;
      }
      const genericView = createGenericExecutionErrorView();
      requestStoreError = genericView.requestStoreError;
      return genericView.response;
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
        requestStoreError
      );
    }
  };
}
