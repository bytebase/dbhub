import { ConnectorType } from "../connectors/interface.js";
import { stripCommentsAndStrings } from "./sql-parser.js";

/**
 * List of allowed keywords for SQL queries
 * Not only SELECT queries are allowed,
 * but also other queries that are not destructive
 */
export const allowedKeywords: Record<ConnectorType, string[]> = {
  postgres: ["select", "with", "explain", "show"],
  mysql: ["select", "with", "explain", "show", "describe", "desc"],
  mariadb: ["select", "with", "explain", "show", "describe", "desc"],
  sqlite: ["select", "with", "explain", "pragma"],
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
  "merge",
  "grant",
  "revoke",
  "rename",
];

/** Base pattern: matches any mutating keyword as a whole word */
const mutatingPattern = new RegExp(
  `\\b(?:${mutatingKeywords.join("|")})\\b`,
  "i",
);

/**
 * Extended pattern for MySQL/MariaDB that also detects REPLACE as a statement.
 * REPLACE(...) function calls are excluded via negative lookahead.
 */
const mutatingPatternMySQL = new RegExp(
  `\\b(?:${mutatingKeywords.join("|")}|replace(?!\\s*\\())\\b`,
  "i",
);

function getMutatingPattern(connectorType: ConnectorType | string): RegExp {
  if (connectorType === "mysql" || connectorType === "mariadb") {
    return mutatingPatternMySQL;
  }
  return mutatingPattern;
}

/** Detects SELECT ... INTO which writes data despite starting with SELECT */
const selectIntoPattern = /\bselect\b[\s\S]+\binto\b/i;

/** Detects EXPLAIN ANALYZE which actually executes the statement.
 *  Matches both `EXPLAIN ANALYZE ...` and `EXPLAIN (ANALYZE) ...` / `EXPLAIN (ANALYZE, ...) ...`.
 *  Excludes explicitly disabled forms: ANALYZE false/off/0 */
const explainAnalyzePattern =
  /^explain\s+(?:\([^)]*\banalyze\b(?!\s*(?:=\s*)?(?:false|off|0)\b)[^)]*\)|\banalyze\b(?!\s*(?:=\s*)?(?:false|off|0)\b)(?:\s+verbose\b)?)/i;

/**
 * Check if a SQL query is read-only.
 * 1. Strips comments and string literals before analyzing.
 * 2. Verifies the first keyword is in the allow-list.
 * 3. For WITH statements, scans for mutating keywords and SELECT INTO.
 * 4. For SELECT statements, checks for SELECT ... INTO.
 * 5. For EXPLAIN statements, rejects EXPLAIN ANALYZE with DML.
 * @param sql The SQL query to check
 * @param connectorType The database type to check against
 * @returns True if the query is read-only
 */
export function isReadOnlySQL(sql: string, connectorType: ConnectorType | string): boolean {
  // Strip comments and strings before analyzing
  const cleanedSQL = stripCommentsAndStrings(sql, connectorType as ConnectorType).trim().toLowerCase();

  // If the statement is empty after removing comments, consider it read-only
  if (!cleanedSQL) {
    return true;
  }

  const firstWord = cleanedSQL.split(/\s+/)[0];

  // Get the appropriate allowed keywords list for this database type
  const keywordList =
    allowedKeywords[connectorType as ConnectorType] || [];

  if (!keywordList.includes(firstWord)) {
    return false;
  }

  // WITH statements can embed DML in CTEs (e.g. WITH cte AS (UPDATE ...))
  // or use SELECT ... INTO in the final query.
  if (firstWord === "with") {
    if (getMutatingPattern(connectorType).test(cleanedSQL)) {
      return false;
    }
    if (selectIntoPattern.test(cleanedSQL)) {
      return false;
    }
  }

  // SELECT ... INTO writes data (creates tables or writes to files)
  if (firstWord === "select" && selectIntoPattern.test(cleanedSQL)) {
    return false;
  }

  // EXPLAIN ANALYZE actually executes the statement (Postgres)
  // Validate the inner statement using the same read-only logic
  if (firstWord === "explain" && explainAnalyzePattern.test(cleanedSQL)) {
    const afterExplain = cleanedSQL.replace(explainAnalyzePattern, "").trim();
    if (afterExplain && !isReadOnlySQL(afterExplain, connectorType)) {
      return false;
    }
  }

  return true;
}
