import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { isReadOnlySQL } from "../utils/allowed-keywords.js";
import { ConnectorType } from "../connectors/interface.js";
import { requestStore } from "../requests/index.js";

/**
 * Extract client identifier from request context
 * Returns User-Agent for HTTP transport, "stdio" for STDIO transport
 */
function getClientIdentifier(extra: any): string {
  // MCP SDK 1.23+ passes requestInfo in extra.requestInfo for HTTP transport
  const userAgent = extra?.requestInfo?.headers?.["user-agent"];
  if (userAgent) {
    return userAgent;
  }

  // Default for STDIO mode
  return "stdio";
}

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
      // Get connector and execute options for the specified source (or default)
      const connector = ConnectorManager.getCurrentConnector(sourceId);
      const executeOptions = ConnectorManager.getCurrentExecuteOptions(sourceId);

      // Check if SQL is allowed based on readonly mode (per-source)
      const isReadonly = executeOptions.readonly === true;
      if (isReadonly && !areAllStatementsReadOnly(sql, connector.id)) {
        errorMessage = `Read-only mode is enabled for source '${effectiveSourceId}'. Only the following SQL operations are allowed: ${allowedKeywords[connector.id]?.join(", ") || "none"}`;
        success = false;
        return createToolErrorResponse(errorMessage, "READONLY_VIOLATION");
      }

      // Execute the SQL (single or multiple statements) if validation passed
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
