import { ConnectorType } from "../connectors/interface.js";
import { stripCommentsAndStrings } from "./sql-parser.js";

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
 * Keywords that indicate data-modifying operations.
 * Used to detect DML/DDL hidden inside CTEs or other constructs.
 */
const mutatingKeywords = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "replace",
  "merge",
  "grant",
  "revoke",
  "rename",
];

/**
 * Matches any of the mutating keywords as whole words.
 * Special-cases REPLACE so that function calls like REPLACE(...)
 * in SELECT queries are not treated as mutating.
 */
const nonReplaceKeywords = mutatingKeywords.filter(k => k !== "replace");
const mutatingPattern = new RegExp(
  `\\b(?:${nonReplaceKeywords.join("|")}|replace(?!\\s*\\())\\b`,
  "i",
);

/**
 * Check if a SQL query is read-only.
 * 1. Strips comments and string literals before analyzing.
 * 2. Verifies the first keyword is in the allow-list.
 * 3. Scans the full statement for mutating keywords (e.g. UPDATE inside a CTE).
 * @param sql The SQL query to check
 * @param connectorType The database type to check against
 * @returns True if the query is read-only
 */
export function isReadOnlySQL(sql: string, connectorType: ConnectorType | string): boolean {
  // Strip comments and strings before analyzing
  const cleanedSQL = stripCommentsAndStrings(sql, connectorType as ConnectorType).trim().toLowerCase();

  // Empty after stripping → deny. Attacker-crafted inputs may reduce to
  // empty strings after comment/string removal to evade keyword checks.
  if (!cleanedSQL) {
    return false;
  }

  const firstWord = cleanedSQL.split(/\s+/)[0];

  // Get the appropriate allowed keywords list for this database type
  const keywordList =
    allowedKeywords[connectorType as ConnectorType] || [];

  if (!keywordList.includes(firstWord)) {
    return false;
  }

  // Even if the first keyword is allowed (e.g. WITH), reject if the statement
  // contains data-modifying keywords anywhere (e.g. WITH cte AS (UPDATE ...))
  if (mutatingPattern.test(cleanedSQL)) {
    return false;
  }

  return true;
}
