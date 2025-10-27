import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { isReadOnlyMode } from "../config/env.js";
import { allowedKeywords } from "../utils/allowed-keywords.js";
import { ConnectorType } from "../connectors/interface.js";

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
 * Remove SQL comments from a query
 * @param sql The SQL query to clean
 * @returns The SQL query without comments
 */
function stripSQLComments(sql: string): string {
  // Remove single-line comments (-- comment)
  let cleaned = sql.split('\n').map(line => {
    const commentIndex = line.indexOf('--');
    return commentIndex >= 0 ? line.substring(0, commentIndex) : line;
  }).join('\n');
  
  // Remove multi-line comments (/* comment */)
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, ' ');
  
  return cleaned.trim();
}

/**
 * Check if a SQL query is read-only based on its first keyword
 * @param sql The SQL query to check
 * @param connectorType The database type to check against
 * @returns True if the query is read-only (starts with allowed keywords)
 */
function isReadOnlySQL(sql: string, connectorType: ConnectorType): boolean {
  // Strip comments before analyzing
  const cleanedSQL = stripSQLComments(sql).toLowerCase();
  
  // If the statement is empty after removing comments, consider it read-only
  if (!cleanedSQL) {
    return true;
  }
  
  const firstWord = cleanedSQL.split(/\s+/)[0];
  
  // Get the appropriate allowed keywords list for this database type
  const keywordList = allowedKeywords[connectorType] || allowedKeywords.default || [];
  
  return keywordList.includes(firstWord);
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
 * execute_sql tool handler
 * Executes a SQL query and returns the results
 */
export async function executeSqlToolHandler({ sql }: { sql: string }, _extra: any, databaseId?: string) {
  const connector = databaseId ? ConnectorManager.getConnector(databaseId) : ConnectorManager.getCurrentConnector();
  const executeOptions = ConnectorManager.getCurrentExecuteOptions();

  try {
    // Check if SQL is allowed based on readonly mode
    if (isReadOnlyMode() && !areAllStatementsReadOnly(sql, connector.id)) {
      return createToolErrorResponse(
        `Read-only mode is enabled. Only the following SQL operations are allowed: ${allowedKeywords[connector.id]?.join(", ") || "none"}`,
        "READONLY_VIOLATION"
      );
    }

    // Execute the SQL (single or multiple statements) if validation passed
    const result = await connector.executeSQL(sql, executeOptions);

    // Build response data
    const responseData = {
      rows: result.rows,
      count: result.rows.length,
      database: databaseId || "default"
    };

    return createToolSuccessResponse(responseData);
  } catch (error) {
    return createToolErrorResponse((error as Error).message, "EXECUTION_ERROR");
  }
}
