import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { allowedKeywords } from "../utils/allowed-keywords.js";
import { ConnectorType } from "../connectors/interface.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL } from "./builtin-tools.js";
import {
  getEffectiveSourceId,
  isAllowedInReadonlyMode,
  trackToolRequest,
} from "../utils/tool-handler-helpers.js";
import { splitSQLStatements } from "../utils/sql-parser.js";
import { getExecuteToolPublicName } from "../utils/execute-tool-name.js";

// Schema for execute_sql tool
export const executeSqlSchema = {
  sql: z.string().describe("SQL to execute (multiple statements separated by semicolons)"),
};

// Schema for Redis execute tool. Handler still accepts the legacy "sql" key
// for compatibility with clients created before Redis got a dedicated name.
export const executeRedisSchema = {
  command: z.string().describe("Redis command(s) to execute (multiple commands separated by semicolons or newlines)"),
};

/**
 * Check if all SQL statements in a multi-statement query are read-only
 * @param sql The SQL string (possibly containing multiple statements)
 * @param connectorType The database type to check against
 * @returns True if all statements are read-only
 */
function areAllStatementsReadOnly(sql: string, connectorType: ConnectorType): boolean {
  if (connectorType === "redis") {
    return isAllowedInReadonlyMode(sql, connectorType);
  }
  const statements = splitSQLStatements(sql, connectorType);
  return statements.every(statement => isAllowedInReadonlyMode(statement, connectorType));
}

/**
 * Create an execute_sql tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to (undefined for single-source mode)
 * @returns A handler function bound to the specified source
 */
export function createExecuteSqlToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const input = args as { sql?: string; command?: string };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;
    let result: any;
    let sql = "";
    let actualSourceId = effectiveSourceId;
    let connectorType: ConnectorType | undefined;
    let isSingleSource = sourceId === undefined;

    try {
      // Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(sourceId);

      // Get connector for the specified source (or default)
      const connector = ConnectorManager.getCurrentConnector(sourceId);
      actualSourceId = connector.getId();
      connectorType = connector.id;
      isSingleSource = ConnectorManager.getAvailableSourceIds().length === 1;
      const statement = connector.id === "redis"
        ? input.command ?? input.sql
        : input.sql ?? input.command;

      if (typeof statement !== "string") {
        errorMessage = connector.id === "redis"
          ? "Missing Redis command input"
          : "Missing SQL input";
        success = false;
        return createToolErrorResponse(errorMessage, "VALIDATION_ERROR");
      }
      sql = statement;

      // Get tool-specific configuration (tool is already registered, so it's enabled)
      const registry = getToolRegistry();
      const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, actualSourceId);

      // Check if SQL is allowed based on readonly mode (per-tool)
      const isReadonly = toolConfig?.readonly === true;
      if (isReadonly && !areAllStatementsReadOnly(sql, connector.id)) {
        const operationType = connector.id === "redis" ? "Redis commands" : "SQL operations";
        errorMessage = `Read-only mode is enabled. Only the following ${operationType} are allowed: ${allowedKeywords[connector.id]?.join(", ") || "none"}`;
        success = false;
        return createToolErrorResponse(errorMessage, "READONLY_VIOLATION");
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
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      // Track the request
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: getExecuteToolPublicName(
            connectorType,
            actualSourceId,
            isSingleSource
          ),
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
