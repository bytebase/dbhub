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
 * Functions callable from a plain SELECT that reach beyond ordinary data
 * access and are NOT contained by a read-only transaction, because they are
 * gated by privilege rather than transaction mode. Matched in call position
 * (trailing `(`) on the comment/string-stripped SQL, so a column or table
 * named `load_file` still classifies as read-only. Per dialect:
 * - MySQL/MariaDB: LOAD_FILE reads server-side files (FILE privilege);
 *   GET_LOCK / RELEASE_LOCK / RELEASE_ALL_LOCKS take or release server-wide
 *   advisory locks (a session side effect).
 * - PostgreSQL: pg_read_file / pg_read_binary_file / pg_ls_dir read the
 *   server filesystem (pg_read_server_files role; default_transaction_read_only
 *   does not apply).
 * - SQL Server: OPENQUERY / OPENROWSET / OPENDATASOURCE run on a
 *   remote/ad-hoc source outside the local read-only transaction
 *   (sqlServerPassThroughKeywords, reused here as the single source of truth).
 *
 * This is a best-effort guardrail: name matching is bypassable (quoted
 * identifiers, executable version comments), so least-privilege database
 * accounts remain the security boundary. See issue #377.
 *
 * NOTE: SQL Server's dynamic-SQL primitives (EXEC / sp_executesql /
 * xp_cmdshell) are NOT here — they are statement-leading forms, not
 * call-position functions, and already fail the first-keyword allow-list in
 * isReadOnlySQL. They classify as admin via sqlServerDynamicSqlPattern.
 */
export const escapeHatchFunctionKeywords: Partial<Record<ConnectorType, readonly string[]>> = {
  mysql: ["load_file", "get_lock", "release_lock", "release_all_locks"],
  mariadb: ["load_file", "get_lock", "release_lock", "release_all_locks"],
  postgres: ["pg_read_file", "pg_read_binary_file", "pg_ls_dir"],
  sqlserver: sqlServerPassThroughKeywords,
};

const escapeHatchFunctionPatterns: Partial<Record<ConnectorType, RegExp>> = Object.fromEntries(
  Object.entries(escapeHatchFunctionKeywords).map(([type, keywords]) => [
    type,
    new RegExp(`\\b(?:${keywords.join("|")})\\s*\\(`, "i"),
  ])
);

/**
 * Whether (comment/string-stripped) SQL invokes one of the dialect's
 * escape-hatch functions in call position.
 */
export function hasEscapeHatchFunction(
  strippedSQL: string,
  connectorType: ConnectorType | string
): boolean {
  const pattern = escapeHatchFunctionPatterns[connectorType as ConnectorType];
  return pattern !== undefined && pattern.test(strippedSQL);
}

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

/**
 * Extract the first keyword of a SQL statement, after stripping comments and
 * string literals so a keyword hidden in a comment/string can't be mistaken
 * for the statement's real leading token. Returns "" for empty/whitespace-only
 * or comment-only input.
 */
export function getFirstKeyword(sql: string, connectorType: ConnectorType | string): string {
  const cleaned = stripCommentsAndStrings(sql, connectorType as ConnectorType).trim();
  return cleaned.match(/\S+/)?.[0]?.toLowerCase() ?? "";
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

  // Escape-hatch functions callable from a plain SELECT that a read-only
  // transaction does not contain — SQL Server pass-through sources
  // (OPENQUERY & co.), MySQL/MariaDB file/lock functions, PostgreSQL
  // filesystem reads. Rejected wherever they appear, since the common form is
  // e.g. `SELECT ... FROM OPENQUERY(...)`. See escapeHatchFunctionKeywords.
  if (hasEscapeHatchFunction(cleanedSQL, connectorType)) {
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
