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
  // SQL Server has no native EXPLAIN statement; the connector translates a
  // leading `EXPLAIN` into a SET SHOWPLAN_XML request (see SQLServerConnector).
  sqlserver: ["select", "with", "explain"],
  // HANA's EXPLAIN PLAN writes to a plan table rather than returning rows.
  hana: ["select", "with"],
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

/**
 * T-SQL dynamic SQL primitives that can run arbitrary (including mutating)
 * statements.
 * - EXEC/EXECUTE: direct dynamic SQL execution
 * - sp_executesql: system proc for parameterized dynamic SQL (callable without
 *   EXEC as the first statement in a batch)
 * - xp_cmdshell: OS command execution
 *
 * Shared with the SQL Server connector's read-only backstop
 * (see executeReadOnly in src/connectors/sqlserver/index.ts), which re-checks
 * these because its rollback guard is application-level rather than
 * engine-enforced. Keep this list as the single source of truth: adding a
 * keyword here must tighten both the classifier and the backstop.
 */
export const sqlServerDynamicSqlKeywords = [
  "execute",
  "exec",
  "sp_executesql",
  "xp_cmdshell",
] as const;

/** Matches any SQL Server dynamic SQL primitive as a whole word */
export const sqlServerDynamicSqlPattern = new RegExp(
  `\\b(?:${sqlServerDynamicSqlKeywords.join("|")})\\b`,
  "i",
);

/**
 * T-SQL pass-through / ad-hoc data source table functions. Unlike the dynamic
 * SQL primitives above, these appear as ordinary table sources inside a plain
 * SELECT, so both read-only layers miss them:
 * - The classifier cannot see the payload, because OPENQUERY carries it as a
 *   string literal that stripCommentsAndStrings deliberately removes.
 * - The rollback backstop cannot contain it, because the work executes on the
 *   remote/ad-hoc source rather than in the local transaction.
 *
 * OPENROWSET additionally reads server-side files in its BULK form
 * (`OPENROWSET(BULK N'C:\...', SINGLE_CLOB)`), which exfiltrates data without
 * writing anything.
 *
 * Shared with executeReadOnly in src/connectors/sqlserver/index.ts on the same
 * single-source-of-truth basis as sqlServerDynamicSqlKeywords.
 */
export const sqlServerPassThroughKeywords = [
  "openquery",
  "openrowset",
  "opendatasource",
] as const;

/**
 * Matches a pass-through data source in call position. The trailing `\s*\(` is
 * required so an ordinary column named `openquery` still classifies as
 * read-only — only the invocation form is a bypass.
 */
export const sqlServerPassThroughPattern = new RegExp(
  `\\b(?:${sqlServerPassThroughKeywords.join("|")})\\s*\\(`,
  "i",
);

/**
 * Extended pattern for SQL Server: base mutating keywords plus the dynamic SQL
 * primitives above.
 */
const mutatingPatternSqlServer = new RegExp(
  `\\b(?:${[...mutatingKeywords, ...sqlServerDynamicSqlKeywords].join("|")})\\b`,
  "i",
);

/** Per-dialect mutating keyword pattern */
const mutatingPatterns: Record<ConnectorType, RegExp> = {
  postgres: mutatingPattern,
  mysql: mutatingPatternWithReplace,
  mariadb: mutatingPatternWithReplace,
  sqlite: mutatingPatternWithReplace,
  sqlserver: mutatingPatternSqlServer,
  hana: mutatingPattern,
};

const selectIntoPattern = /\bselect\b[\s\S]+\binto\b/i;

/**
 * SQLite read-only introspection pragmas that legitimately take a parenthesized
 * argument (a table/index name) and return rows without mutating state. Any other
 * pragma using the parenthesized form is a setter (e.g. `PRAGMA user_version(1)`,
 * `PRAGMA query_only(0)`), which SQLite treats identically to the `= value` form.
 */
const sqliteReadOnlyArgPragmas = new Set([
  "table_info",
  "index_info",
  "index_list",
  "foreign_key_list",
]);

/** Matches `PRAGMA [schema.]name(` to extract the pragma name of the parenthesized form. */
const sqlitePragmaParenPattern = /^pragma\s+(?:[a-z0-9_]+\.)?([a-z0-9_]+)\s*\(/;

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

  // SQL Server pass-through data sources escape both read-only layers, so they
  // are rejected wherever they appear — not just under WITH, since the common
  // form is a plain `SELECT ... FROM OPENQUERY(...)`.
  if (connectorType === "sqlserver" && sqlServerPassThroughPattern.test(cleanedSQL)) {
    return false;
  }

  // WITH statements can embed DML in CTEs (e.g. WITH cte AS (UPDATE ...))
  if (firstWord === "with") {
    const pattern = mutatingPatterns[connectorType as ConnectorType] ?? mutatingPattern;
    if (pattern.test(cleanedSQL)) {
      return false;
    }
  }

  // SQLite PRAGMA: a pragma that sets a value mutates durable or session state and
  // must not classify as read-only. SQLite accepts a setter in two equivalent
  // forms — `PRAGMA name = value` and `PRAGMA name(value)` — so checking for `=`
  // alone is not enough. Reject the assignment form, and reject the parenthesized
  // form unless the pragma is a known introspection pragma (e.g. `table_info(t)`)
  // that takes an argument purely to return rows. The bare query form
  // (`PRAGMA user_version`) returns the value and is allowed.
  if (firstWord === "pragma" && connectorType === "sqlite") {
    if (cleanedSQL.includes("=")) {
      return false;
    }
    const parenMatch = cleanedSQL.match(sqlitePragmaParenPattern);
    if (parenMatch && !sqliteReadOnlyArgPragmas.has(parenMatch[1])) {
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

  return true;
}
