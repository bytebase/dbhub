import { blankCommentsAndStrings } from "./sql-parser.js";
import type { ConnectorType, SQLResultSet } from "../connectors/interface.js";
import { hasMutatingKeyword } from "./allowed-keywords.js";

/**
 * Result of a maxRows rewrite that supports truncation detection.
 *
 * When `probeApplied` is true, the rewritten SQL requests `maxRows + 1` rows
 * (a probe row): if the database returns more than `maxRows` rows, the query
 * provably had more rows than the cap allows. The caller must pass the
 * executed result through `SQLRowLimiter.flagTruncation()` to drop the probe
 * row and mark the result set as truncated.
 */
export interface MaxRowsRewrite {
  sql: string;
  probeApplied: boolean;
}

/** Position and value of a clause found at parenthesis depth 0. */
interface TopLevelClause {
  index: number;
  length: number;
  /** Null when the clause holds a parameter placeholder instead of a literal. */
  value: number | null;
}

/**
 * Shared utility for applying row limits to row-returning queries using
 * database-native LIMIT clauses (or TOP on SQL Server).
 *
 * Every check reasons about the statement's *own* clauses: the SQL is blanked
 * of comments and string literals, then scanned with parenthesis-depth
 * tracking, so a LIMIT/TOP/ORDER BY belonging to a CTE body, a subquery, or
 * one branch of a set operation is never mistaken for the statement's own.
 * Such a nested clause caps only its branch, so the statement still needs a
 * cap of its own.
 */
export class SQLRowLimiter {
  /**
   * Check if a SQL statement is a row-returning query that can benefit from row limiting.
   *
   * Classification runs on the comment-blanked text, so a query introduced by a
   * `--` or `/* ... *\/` comment (a query tag, say) is classified by its real
   * leading keyword. The SQL sent to the server is never rewritten by this
   * check, so an attribution comment survives verbatim.
   *
   * `WITH` leads a CTE whose final statement is normally a SELECT, so it is
   * limitable too, except for a data-modifying CTE
   * (`WITH x AS (DELETE ... RETURNING *) SELECT ...`), where a LIMIT would cap
   * the rows handed back while the write still runs in full. Detection there is
   * the same keyword heuristic the read-only classifier uses, so a false
   * positive only means the statement keeps the old behaviour of not being limited.
   *
   * `dialect` selects the connector's scanner so dialect-specific quoting
   * (PostgreSQL dollar quotes, MySQL backticks, SQL Server brackets) is
   * blanked the same way the read-only classifier blanks it; without it only
   * ANSI syntax is recognized.
   */
  static isSelectQuery(sql: string, dialect?: ConnectorType): boolean {
    const blankedSQL = blankCommentsAndStrings(sql, dialect).trim().toLowerCase();
    // Leading parentheses are skipped: `(SELECT ...) UNION (SELECT ...)` is a
    // row-returning statement whose first token is `(`. So is a leading
    // statement separator: T-SQL convention prefixes a CTE as `;WITH`.
    const firstKeyword = /^[(;\s]*([a-z_]+)/.exec(blankedSQL)?.[1] ?? "";
    if (firstKeyword === "select") {
      return true;
    }
    return firstKeyword === "with" && !hasMutatingKeyword(blankedSQL, dialect);
  }

  /**
   * Check if a SQL statement has a LIMIT clause of its own (not one nested in
   * a CTE body or subquery).
   */
  static hasLimitClause(sql: string, dialect?: ConnectorType): boolean {
    return this.findTopLevelLimit(sql, dialect) !== null;
  }

  /**
   * Check if a SQL statement has a TOP clause of its own (SQL Server).
   */
  static hasTopClause(sql: string): boolean {
    return this.findTopLevelTop(sql) !== null;
  }

  /**
   * Extract the statement's own LIMIT value. Null when it has no LIMIT of its
   * own, or when that LIMIT is a parameter placeholder rather than a literal
   * (see hasParameterizedLimit).
   */
  static extractLimitValue(sql: string, dialect?: ConnectorType): number | null {
    return this.findTopLevelLimit(sql, dialect)?.value ?? null;
  }

  /**
   * Extract the statement's own TOP value (SQL Server), or null when it has none.
   */
  static extractTopValue(sql: string): number | null {
    return this.findTopLevelTop(sql)?.value ?? null;
  }

  /**
   * Check if the statement's own LIMIT clause uses a parameter placeholder
   * ($1, ?, @p1) instead of a literal number.
   */
  static hasParameterizedLimit(sql: string, dialect?: ConnectorType): boolean {
    const limit = this.findTopLevelLimit(sql, dialect);
    return limit !== null && limit.value === null;
  }

  /**
   * Add or tighten the LIMIT clause of a SQL statement
   */
  static applyLimitToQuery(sql: string, maxRows: number, dialect?: ConnectorType): string {
    const limit = this.findTopLevelLimit(sql, dialect);

    if (limit !== null && limit.value !== null) {
      // Splice at the clause's own position rather than replacing the first
      // LIMIT found textually, which on a CTE would rewrite the CTE's cap and
      // leave the statement itself uncapped.
      const effectiveLimit = Math.min(limit.value, maxRows);
      return `${sql.slice(0, limit.index)}LIMIT ${effectiveLimit}${sql.slice(limit.index + limit.length)}`;
    }

    // Add LIMIT clause to the end of the query
    // Handle semicolon at the end
    const { sql: sqlWithoutSemicolon, semicolon } = trimSemicolon(sql);

    // Append on a new line: if the query ends in a `--` line comment, a
    // same-line LIMIT would land inside the comment and be inert.
    return `${sqlWithoutSemicolon}\nLIMIT ${maxRows}${semicolon}`;
  }

  /**
   * Scan blanked (comment/string-free, length-preserving) SQL for parenthesis
   * depth, invoking onMatch for every regex hit at depth 0 (i.e. not nested
   * inside a subquery, function call, or window OVER clause).
   */
  private static scanTopLevel(
    blankedSQL: string,
    regex: RegExp,
    onMatch: (match: RegExpExecArray) => void
  ): void {
    let depth = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(blankedSQL)) !== null) {
      const token = m[0];
      if (token === "(") { depth++; }
      else if (token === ")") { depth--; }
      else if (depth === 0) { onMatch(m); }
    }
  }

  /**
   * The first or last regex match at parenthesis depth 0, i.e. one belonging
   * to the statement itself rather than to a nested query. Match indices refer
   * to positions in the original `sql`, since blankCommentsAndStrings
   * preserves length. The regex must offer `\(` and `\)` alternatives so depth
   * can be tracked, and must carry the `g` flag.
   */
  private static findTopLevelMatch(
    sql: string,
    regex: RegExp,
    pick: "first" | "last",
    dialect?: ConnectorType
  ): RegExpExecArray | null {
    let found: RegExpExecArray | null = null;
    this.scanTopLevel(blankCommentsAndStrings(sql, dialect), regex, (m) => {
      if (pick === "last" || found === null) {
        found = m;
      }
    });
    return found;
  }

  /** The statement's own LIMIT clause, literal or parameterized ($1, ?, @p1). */
  private static findTopLevelLimit(sql: string, dialect?: ConnectorType): TopLevelClause | null {
    const match = this.findTopLevelMatch(
      sql,
      /\(|\)|\blimit\s+(?:(\d+)|\$\d+|\?|@p\d+)/gi,
      "last",
      dialect
    );
    if (match === null) {
      return null;
    }
    return {
      index: match.index,
      length: match[0].length,
      value: match[1] !== undefined ? parseInt(match[1], 10) : null,
    };
  }

  /** The statement's own `SELECT TOP n` clause (SQL Server). */
  private static findTopLevelTop(sql: string): (TopLevelClause & { value: number }) | null {
    const match = this.findTopLevelMatch(sql, /\(|\)|\bselect\s+top\s+(\d+)/gi, "first", "sqlserver");
    if (match === null) {
      return null;
    }
    return { index: match.index, length: match[0].length, value: parseInt(match[1], 10) };
  }

  /**
   * The statement's own SELECT keyword (SQL Server). For a CTE this is the
   * final SELECT, not the one inside a CTE body.
   */
  private static findTopLevelSelect(sql: string): RegExpExecArray | null {
    return this.findTopLevelMatch(sql, /\(|\)|\bselect\b/gi, "first", "sqlserver");
  }

  /**
   * Check if a SQL statement combines multiple SELECTs with a set operator
   * (UNION [ALL], INTERSECT, EXCEPT) at the top level — i.e. not nested
   * inside a subquery already wrapped in parentheses.
   */
  static hasSetOperator(sql: string): boolean {
    return (
      this.findTopLevelMatch(sql, /\(|\)|\bunion\b|\bintersect\b|\bexcept\b/gi, "first", "sqlserver") !==
      null
    );
  }

  /**
   * Find the start index of a top-level trailing ORDER BY clause (not one
   * nested inside a subquery or a window function's OVER (...) clause).
   * Returns -1 if none exists.
   */
  private static findTopLevelOrderByIndex(sql: string): number {
    return this.findTopLevelMatch(sql, /\(|\)|\border\s+by\b/gi, "last", "sqlserver")?.index ?? -1;
  }

  /**
   * Add or modify TOP clause in a SQL statement (SQL Server)
   */
  static applyTopToQuery(sql: string, maxRows: number): string {
    if (this.hasSetOperator(sql)) {
      // TOP applied anywhere inside the statement (e.g. on the first SELECT,
      // or on one branch) only caps that branch's rows, not the combined
      // UNION/INTERSECT/EXCEPT output, so wrap the whole statement and cap
      // the outer result set instead, regardless of any TOP already present
      // on an individual branch.
      const { sql: sqlWithoutSemicolon, semicolon } = trimSemicolon(sql);

      // A leading CTE stays outside the derived table: T-SQL has no
      // `SELECT ... FROM (WITH ...) AS subq` form, but a CTE declared before
      // the SELECT is still in scope inside that derived table.
      const cteIndex = this.findTopLevelSelect(sqlWithoutSemicolon)?.index ?? 0;
      const ctePrefix = sqlWithoutSemicolon.slice(0, cteIndex);
      const body = sqlWithoutSemicolon.slice(cteIndex);

      // A top-level ORDER BY must move outside the derived table: T-SQL
      // disallows ORDER BY inside a subquery unless that subquery itself has
      // TOP/OFFSET/FOR XML, so leaving it inside would break the query.
      const orderByIndex = this.findTopLevelOrderByIndex(body);
      if (orderByIndex !== -1) {
        const innerSql = body.slice(0, orderByIndex).trimEnd();
        const orderByClause = body.slice(orderByIndex).trim();
        return `${ctePrefix}SELECT TOP ${maxRows} * FROM (${innerSql}\n) AS subq ${orderByClause}${semicolon}`;
      }

      return `${ctePrefix}SELECT TOP ${maxRows} * FROM (${body}\n) AS subq${semicolon}`;
    }

    const existingTop = this.findTopLevelTop(sql);
    if (existingTop !== null) {
      // Use the minimum of existing top and maxRows
      const effectiveTop = Math.min(existingTop.value, maxRows);
      return `${sql.slice(0, existingTop.index)}SELECT TOP ${effectiveTop}${sql.slice(existingTop.index + existingTop.length)}`;
    }

    // Add TOP to the statement's own SELECT: for a CTE that is the final
    // SELECT, not the one inside a CTE body.
    const selectMatch = this.findTopLevelSelect(sql);
    if (selectMatch === null) {
      return sql;
    }
    return `${sql.slice(0, selectMatch.index)}SELECT TOP ${maxRows}${sql.slice(selectMatch.index + selectMatch[0].length)}`;
  }

  /**
   * Apply maxRows limit to a row-returning query only
   *
   * This method is used by PostgreSQL, MySQL, MariaDB, and SQLite connectors which all support
   * the LIMIT clause syntax. SQL Server uses applyMaxRowsForSQLServer() instead with TOP syntax.
   *
   * For parameterized LIMIT clauses (e.g., LIMIT $1 or LIMIT ?), we wrap the query in a subquery
   * to enforce max_rows as a hard cap, since the parameter value is not known until runtime.
   *
   * `dialect` selects the connector's comment/string scanner (see isSelectQuery).
   */
  static applyMaxRows(sql: string, maxRows: number | undefined, dialect?: ConnectorType): string {
    if (!maxRows || !this.isSelectQuery(sql, dialect)) {
      return sql;
    }

    // If query has a parameterized LIMIT, wrap it in a subquery with maxRows
    // This ensures max_rows is respected even when user provides a large parameter value
    if (this.hasParameterizedLimit(sql, dialect)) {
      // Wrap the query: SELECT * FROM (original_query) AS subq LIMIT max_rows
      // Note: Subquery wrapping is safe for PostgreSQL, MySQL, MariaDB, and SQLite
      const { sql: sqlWithoutSemicolon, semicolon } = trimSemicolon(sql);
      // Close the subquery on a new line: if the inner query ends in a `--`
      // line comment, a same-line `)` would be swallowed by the comment and
      // the wrapped statement would be syntactically broken.
      return `SELECT * FROM (${sqlWithoutSemicolon}\n) AS subq LIMIT ${maxRows}${semicolon}`;
    }

    // For literal LIMIT values, apply the minimum logic
    return this.applyLimitToQuery(sql, maxRows, dialect);
  }

  /**
   * Apply maxRows limit to a row-returning query using SQL Server TOP syntax
   */
  static applyMaxRowsForSQLServer(sql: string, maxRows: number | undefined): string {
    if (!maxRows || !this.isSelectQuery(sql, "sqlserver")) {
      return sql;
    }
    return this.applyTopToQuery(sql, maxRows);
  }

  /**
   * Apply maxRows to a row-returning query using Oracle's row-limiting clause.
   *
   * The statement is always wrapped in an inline view and capped from the
   * outside: `SELECT * FROM (<sql>) FETCH FIRST n ROWS ONLY`. Wrapping rather
   * than splicing keeps every shape correct with one rule - a set operation
   * (UNION & co.) is capped as a whole, a trailing ORDER BY stays inside the
   * view where Oracle honours it, and a query that already has its own
   * `FETCH FIRST` / `ROWNUM` cap simply returns the smaller of the two. Oracle
   * also accepts a leading CTE (subquery factoring) inside an inline view, so
   * `WITH ... SELECT` needs no special casing.
   */
  static applyMaxRowsForOracle(sql: string, maxRows: number | undefined): string {
    if (!maxRows || !this.isSelectQuery(sql, "oracle") || this.hasOracleForUpdate(sql)) {
      return sql;
    }
    const { sql: sqlWithoutSemicolon } = trimSemicolon(sql);
    // Close the inline view on a new line so a trailing `--` comment in the
    // inner query cannot swallow the `)`. No trailing semicolon: the Oracle
    // driver rejects one on a plain SQL statement (ORA-00933).
    return `SELECT * FROM (${sqlWithoutSemicolon}\n) FETCH FIRST ${maxRows} ROWS ONLY`;
  }

  /**
   * A statement-level `FOR UPDATE` (locking read). Oracle allows neither
   * `FOR UPDATE` inside an inline view nor a row-limiting clause alongside
   * it, so such a statement cannot be capped and is left as written.
   */
  private static hasOracleForUpdate(sql: string): boolean {
    return this.findTopLevelMatch(sql, /\(|\)|\bfor\s+update\b/gi, "first", "oracle") !== null;
  }

  /**
   * Oracle variant of applyMaxRowsWithTruncationProbe. Because the cap always
   * wraps (see applyMaxRowsForOracle), the probe is applied to every
   * row-returning statement; a query whose own cap is tighter than maxRows
   * returns fewer than maxRows + 1 rows and is therefore never flagged.
   * A `FOR UPDATE` statement is never capped (see hasOracleForUpdate).
   */
  static applyMaxRowsForOracleWithTruncationProbe(
    sql: string,
    maxRows: number | undefined
  ): MaxRowsRewrite {
    if (!maxRows || !this.isSelectQuery(sql, "oracle") || this.hasOracleForUpdate(sql)) {
      return { sql, probeApplied: false };
    }
    return { sql: this.applyMaxRowsForOracle(sql, maxRows + 1), probeApplied: true };
  }

  /**
   * Like applyMaxRows, but requests one probe row (maxRows + 1) whenever the
   * cap is the binding constraint, so callers can detect truncation exactly
   * instead of guessing from `rowCount === maxRows` (which a table with
   * exactly maxRows rows also produces).
   *
   * `probeApplied` is false when the cap cannot fire: no maxRows, not a
   * SELECT, or the query's own literal LIMIT is already within the cap (the
   * user asked for fewer rows than the cap — that is their limit, not
   * truncation).
   */
  static applyMaxRowsWithTruncationProbe(
    sql: string,
    maxRows: number | undefined,
    dialect?: ConnectorType
  ): MaxRowsRewrite {
    if (!maxRows || !this.isSelectQuery(sql, dialect)) {
      return { sql, probeApplied: false };
    }
    if (!this.hasParameterizedLimit(sql, dialect)) {
      const existingLimit = this.extractLimitValue(sql, dialect);
      if (existingLimit !== null && existingLimit <= maxRows) {
        return { sql, probeApplied: false };
      }
    }
    return { sql: this.applyMaxRows(sql, maxRows + 1, dialect), probeApplied: true };
  }

  /**
   * SQL Server variant of applyMaxRowsWithTruncationProbe, using TOP syntax.
   * A set-operator statement is always wrapped (any TOP on an individual
   * branch caps only that branch, not the combined output), so the probe
   * applies there regardless of branch-level TOPs.
   */
  static applyMaxRowsForSQLServerWithTruncationProbe(
    sql: string,
    maxRows: number | undefined
  ): MaxRowsRewrite {
    if (!maxRows || !this.isSelectQuery(sql, "sqlserver")) {
      return { sql, probeApplied: false };
    }
    if (!this.hasSetOperator(sql)) {
      const existingTop = this.extractTopValue(sql);
      if (existingTop !== null && existingTop <= maxRows) {
        return { sql, probeApplied: false };
      }
    }
    return { sql: this.applyMaxRowsForSQLServer(sql, maxRows + 1), probeApplied: true };
  }

  /**
   * Post-process a result set produced by a truncation-probe rewrite: when
   * the probe row came back (more than maxRows rows), drop it, clamp the
   * count to maxRows, and mark the set truncated so consumers can tell a
   * capped result from a complete one.
   */
  static flagTruncation(
    resultSet: SQLResultSet,
    maxRows: number | undefined,
    probeApplied: boolean
  ): void {
    if (!probeApplied || !maxRows || resultSet.rows.length <= maxRows) {
      return;
    }
    resultSet.rows = resultSet.rows.slice(0, maxRows);
    resultSet.rowCount = maxRows;
    resultSet.truncated = true;
  }
}

/**
 * Split a trailing semicolon off a statement so a wrapper/suffix can be spliced
 * in before it, and the caller can put it back.
 */
function trimSemicolon(sql: string): { sql: string; semicolon: "" | ";" } {
  const trimmed = sql.trim();
  return trimmed.endsWith(";")
    ? { sql: trimmed.slice(0, -1), semicolon: ";" }
    : { sql: trimmed, semicolon: "" };
}
