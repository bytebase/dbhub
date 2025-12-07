import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { isReadOnlySQL, allowedKeywords } from "../utils/allowed-keywords.js";
import { ConnectorType } from "../connectors/interface.js";
import { requestStore } from "../requests/index.js";
import { getClientIdentifier } from "../utils/client-identifier.js";
import { getToolRegistry } from "./registry.js";
import { BUILTIN_TOOL_EXECUTE_SQL } from "./builtin-tools.js";

// Schema for execute_sql tool
export const executeSqlSchema = {
  sql: z.string().describe("SQL query or multiple SQL statements to execute (separated by semicolons)"),
};

/**
 * Split SQL string into individual statements, handling semicolons properly
 * @param sql The SQL string to split
 * @returns Array of individual SQL statements
 */
function splitSQLStatements(sql: string): string[] {
  // Split by semicolon and filter out empty statements
  return sql.split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);
}

/**
 * Check if all SQL statements in a multi-statement query are read-only
 * @param sql The SQL string (possibly containing multiple statements)
 * @param connectorType The database type to check against
 * @returns True if all statements are read-only
 */
function areAllStatementsReadOnly(sql: string, connectorType: ConnectorType): boolean {
  const statements = splitSQLStatements(sql);
  return statements.every(statement => isReadOnlySQL(statement, connectorType));
}

/**
 * Create an execute_sql tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to (undefined for single-source mode)
 * @returns A handler function bound to the specified source
 */
export function createExecuteSqlToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { sql } = args as { sql: string };
    const startTime = Date.now();
    const effectiveSourceId = sourceId || "default";
    let success = true;
    let errorMessage: string | undefined;
    let result: any;

    try {
      // Get connector for the specified source (or default)
      const connector = ConnectorManager.getCurrentConnector(sourceId);
      const actualSourceId = connector.getId();

      // Get tool-specific configuration (tool is already registered, so it's enabled)
      const registry = getToolRegistry();
      const toolConfig = registry.getBuiltinToolConfig(BUILTIN_TOOL_EXECUTE_SQL, actualSourceId);

      // Check if SQL is allowed based on readonly mode (per-tool)
      const isReadonly = toolConfig?.readonly === true;
      if (isReadonly && !areAllStatementsReadOnly(sql, connector.id)) {
        errorMessage = `Read-only mode is enabled for source '${actualSourceId}'. Only the following SQL operations are allowed: ${allowedKeywords[connector.id]?.join(", ") || "none"}`;
        success = false;
        return createToolErrorResponse(errorMessage, "READONLY_VIOLATION");
      }

      // Execute the SQL (single or multiple statements) if validation passed
      // Pass max_rows from tool config (if set)
      const executeOptions = {
        readonly: isReadonly,
        max_rows: toolConfig?.max_rows,
      };
      result = await connector.executeSQL(sql, executeOptions);

      // Build response data
      const responseData = {
        rows: result.rows,
        count: result.rows.length,
        source_id: effectiveSourceId,
      };

      return createToolSuccessResponse(responseData);
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      // Track the request
      requestStore.add({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sourceId: effectiveSourceId,
        toolName: effectiveSourceId === "default" ? "execute_sql" : `execute_sql_${effectiveSourceId}`,
        sql,
        durationMs: Date.now() - startTime,
        client: getClientIdentifier(extra),
        success,
        error: errorMessage,
      });
    }
  };
}
