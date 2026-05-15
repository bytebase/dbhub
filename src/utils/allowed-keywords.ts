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
 * Dangerous functions that can perform privileged operations (file I/O,
 * connection management, configuration changes) despite appearing in
 * read-only SELECT statements. These are gated by database role privileges
 * at the server level, but should also be blocked by the readonly keyword
 * check as a defence-in-depth measure.
 */
const dangerousFunctions: Record<ConnectorType, RegExp | null> = {
  postgres: /\b(?:pg_read_file|pg_read_binary_file|pg_ls_dir|pg_ls_logdir|pg_ls_waldir|pg_ls_tmpdir|pg_ls_archive_statusdir|pg_ls_replslotdir|pg_ls_logicalmapdir|pg_ls_logicalsnapdir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|set_config|dblink|dblink_exec|dblink_connect|dblink_send_query|lo_export|lo_import|pg_file_write|pg_file_rename|pg_file_unlink)\s*\(/i,
  mysql: /\b(?:load_file\s*\(|into\s+(?:outfile|dumpfile))/i,
  mariadb: /\b(?:load_file\s*\(|into\s+(?:outfile|dumpfile))/i,
  sqlite: null,
  sqlserver: /\b(?:xp_cmdshell|xp_fileexist|xp_dirtree|xp_subdirs|xp_fixeddrives|openrowset|opendatasource|openquery|bulk\s+insert)\s*\(/i,
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
 * Extended pattern for dialects that support REPLACE INTO (MySQL/MariaDB/SQLite).
 * Only matches `REPLACE INTO` (with optional LOW_PRIORITY/DELAYED), not
 * REPLACE() function calls or identifiers named `replace`.
 */
const mutatingPatternWithReplace = new RegExp(
  `\\b(?:${mutatingKeywords.join("|")}|replace\\s+(?:(?:low_priority|delayed)\\s+)?into)\\b`,
  "i",
);

/** Per-dialect mutating keyword pattern */
const mutatingPatterns: Record<ConnectorType, RegExp> = {
  postgres: mutatingPattern,
  mysql: mutatingPatternWithReplace,
  mariadb: mutatingPatternWithReplace,
  sqlite: mutatingPatternWithReplace,
  sqlserver: mutatingPattern,
};

const selectIntoPattern = /\bselect\b[\s\S]+\binto\b/i;

/** Matches EXPLAIN ANALYZE (or parenthesized form), excluding disabled forms (false/off/0) */
const explainAnalyzePattern =
  /^explain\s+(?:\([^)]*\banalyze\b(?!\s*(?:=\s*)?(?:false|off|0)\b)[^)]*\)|\banalyze\b(?!\s*(?:=\s*)?(?:false|off|0)\b)(?:\s+verbose\b)?)/i;

/**
 * Check if a SQL query is read-only.
 * 1. Strips comments and string literals before analyzing.
 * 2. Verifies the first keyword is in the allow-list.
 * 3. For WITH/SELECT statements, checks for mutating keywords and SELECT INTO.
 * 4. For EXPLAIN statements, rejects EXPLAIN ANALYZE with DML.
 */
export function isReadOnlySQL(sql: string, connectorType: ConnectorType | string): boolean {
  return checkReadOnly(
    stripCommentsAndStrings(sql, connectorType as ConnectorType).trim().toLowerCase(),
    connectorType,
  );
}

function checkReadOnly(cleanedSQL: string, connectorType: ConnectorType | string): boolean {
  // Empty after stripping → deny. Attacker-crafted inputs may reduce to
  // empty strings after comment/string removal to evade keyword checks.
  if (!cleanedSQL) {
    return false;
  }

  const firstWord = cleanedSQL.match(/\S+/)?.[0] ?? "";

  const keywordList =
    allowedKeywords[connectorType as ConnectorType] || [];

  if (!keywordList.includes(firstWord)) {
    return false;
  }

  // WITH statements can embed DML in CTEs (e.g. WITH cte AS (UPDATE ...))
  if (firstWord === "with") {
    const pattern = mutatingPatterns[connectorType as ConnectorType] ?? mutatingPattern;
    if (pattern.test(cleanedSQL)) {
      return false;
    }
  }

  // SELECT/WITH ... INTO writes data (creates tables or writes to files)
  if ((firstWord === "select" || firstWord === "with") && selectIntoPattern.test(cleanedSQL)) {
    return false;
  }

  // EXPLAIN ANALYZE actually executes the statement (Postgres)
  if (firstWord === "explain") {
    const m = explainAnalyzePattern.exec(cleanedSQL);
    if (m) {
      const afterExplain = cleanedSQL.slice(m[0].length).trim();
      if (afterExplain && !checkReadOnly(afterExplain, connectorType)) {
        return false;
      }
    }
  }

  // Block dangerous functions that can perform filesystem I/O or
  // configuration changes despite being inside a valid SELECT statement.
  const dangerousPattern = dangerousFunctions[connectorType as ConnectorType];
  if (dangerousPattern && dangerousPattern.test(cleanedSQL)) {
    return false;
  }

  return true;
}
