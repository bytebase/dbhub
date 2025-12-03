import { ConnectorType } from "../connectors/interface.js";

/**
 * List of allowed keywords for SQL queries
 * Not only SELECT queries are allowed,
 * but also other queries that are not destructive
 */
export const allowedKeywords: Record<ConnectorType, string[]> = {
  postgres: ["select", "with", "explain", "analyze", "show"],
  mysql: ["select", "with", "explain", "analyze", "show", "describe", "desc"],
  mariadb: ["select", "with", "explain", "analyze", "show", "describe", "desc"],
  sqlite: ["select", "with", "explain", "analyze", "pragma"],
  sqlserver: ["select", "with", "explain", "showplan"],
};

/**
 * Remove SQL comments from a query.
 * Handles single-line (--) and multi-line comments.
 * @param sql The SQL query to clean
 * @returns The SQL query without comments
 */
export function stripSQLComments(sql: string): string {
  // Remove single-line comments (-- comment)
  let cleaned = sql
    .split("\n")
    .map((line) => {
      const commentIndex = line.indexOf("--");
      return commentIndex >= 0 ? line.substring(0, commentIndex) : line;
    })
    .join("\n");

  // Remove multi-line comments (/* comment */)
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, " ");

  return cleaned.trim();
}

/**
 * Check if a SQL query is read-only based on its first keyword.
 * Strips comments before analyzing to avoid false positives from commented-out statements.
 * @param sql The SQL query to check
 * @param connectorType The database type to check against
 * @returns True if the query is read-only (starts with allowed keywords)
 */
export function isReadOnlySQL(sql: string, connectorType: ConnectorType | string): boolean {
  // Strip comments before analyzing
  const cleanedSQL = stripSQLComments(sql).toLowerCase();

  // If the statement is empty after removing comments, consider it read-only
  if (!cleanedSQL) {
    return true;
  }

  const firstWord = cleanedSQL.split(/\s+/)[0];

  // Get the appropriate allowed keywords list for this database type
  const keywordList =
    allowedKeywords[connectorType as ConnectorType] || [];

  return keywordList.includes(firstWord);
}
