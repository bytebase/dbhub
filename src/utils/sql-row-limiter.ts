import type { ConnectorType } from "../connectors/interface.js";
import { hasMutatingKeyword } from "./allowed-keywords.js";
import { blankCommentsAndStrings } from "./sql-parser.js";

/**
 * Shared utility for applying row limits to row-returning queries using
 * database-native LIMIT clauses (or TOP on SQL Server).
 *
 * Every check here reasons about the statement's *own* clauses: the SQL is
 * first blanked of comments and string literals, then scanned with parenthesis
 * depth tracking, so a LIMIT/TOP/ORDER BY belonging to a CTE body, a subquery,
 * or one branch of a set operation is never mistaken for the statement's own.
 * Such a nested clause caps only its own branch, so the statement still needs
 * a cap of its own.
 */
export class SQLRowLimiter {
  /**
   * Check if a SQL statement is a row-returning query that can benefit from row limiting.
   *
   * Classification runs on the comment-blanked text, so a query introduced by a
   * `--` or `/* ... *\/` comment — a query tag, say — is classified by its real
   * leading keyword rather than by the comment. The SQL the caller wrote is
   * never rewritten by this check: only the classification sees the blanked
   * form, so an attribution comment survives to the server verbatim.
   *
   * `WITH` leads a CTE whose final statement is normally a SELECT, so it is
   * limitable too — except for a data-modifying CTE
   * (`WITH x AS (DELETE ... RETURNING *) SELECT ...`), where a LIMIT would cap
   * the rows handed back while the write still runs in full: a cap that isn't
   * one. Detection there is the same keyword heuristic the read-only classifier
   * uses, so a false positive only means the statement keeps today's behaviour
   * of not being limited.
   */
  static isSelectQuery(sql: string): boolean {
    const blankedSQL = blankCommentsAndStrings(sql).trim().toLowerCase();
    // Leading parentheses are skipped: `(SELECT ...) UNION (SELECT ...)` is a
    // row-returning statement whose first token is `(`.
    const firstKeyword = /^[(\s]*([a-z_]+)/.exec(blankedSQL)?.[1] ?? "";
    if (firstKeyword === "select") {
      return true;
    }
    return firstKeyword === "with" && !hasMutatingKeyword(blankedSQL);
  }

  /**
   * Check if a SQL statement has a LIMIT clause of its own.
   */
  static hasLimitClause(sql: string): boolean {
    return this.findTopLevelLimit(sql) !== null;
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
  static extractLimitValue(sql: string): number | null {
    return this.findTopLevelLimit(sql)?.value ?? null;
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
  static hasParameterizedLimit(sql: string): boolean {
    const limit = this.findTopLevelLimit(sql);
    return limit !== null && limit.value === null;
  }

  /**
   * Add or tighten the LIMIT clause of a SQL statement
   */
  static applyLimitToQuery(sql: string, maxRows: number): string {
    const limit = this.findTopLevelLimit(sql);

    if (limit !== null && limit.value !== null) {
      // Splice at the clause's own position rather than replacing the first
      // LIMIT found textually, which on a CTE would rewrite the CTE's cap and
      // leave the statement itself uncapped.
      const effectiveLimit = Math.min(limit.value, maxRows);
      return `${sql.slice(0, limit.index)}LIMIT ${effectiveLimit}${sql.slice(limit.index + limit.length)}`;
    }

    const { sql: sqlWithoutSemicolon, semicolon } = trimSemicolon(sql);

    if (limit !== null) {
      // Parameterized LIMIT: the value only exists at execution time, so it
      // cannot be compared against maxRows here. Wrap the statement and cap
      // the outer result set to enforce max_rows as a hard ceiling.
      // Note: subquery wrapping is safe for PostgreSQL, MySQL, MariaDB and SQLite.
      // Close the subquery on a new line: if the inner query ends in a `--`
      // line comment, a same-line `)` would be swallowed by the comment and
      // the wrapped statement would be syntactically broken.
      return `SELECT * FROM (${sqlWithoutSemicolon}\n) AS subq LIMIT ${maxRows}${semicolon}`;
    }

    // Append on a new line: if the query ends in a `--` line comment, a
    // same-line LIMIT would land inside the comment and be inert.
    return `${sqlWithoutSemicolon}\nLIMIT ${maxRows}${semicolon}`;
  }

  /**
   * Scan blanked (comment/string-free, length-preserving) SQL for parenthesis
   * depth, invoking onMatch for every regex hit at depth 0 (i.e. not nested
   * inside a CTE body, subquery, function call, or window OVER clause).
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
   * The first or last regex match at parenthesis depth 0 — one belonging to the
   * statement itself rather than to a nested query. Match indices refer to
   * positions in the original `sql`, since blankCommentsAndStrings preserves
   * length. The regex must offer `\(` and `\)` alternatives so depth can be
   * tracked, and must carry the `g` flag.
   */
  private static findTopLevelMatch(
    sql: string,
    regex: RegExp,
    pick: "first" | "last",
    dialect?: ConnectorType
  ): RegExpExecArray | null {
    const matches: RegExpExecArray[] = [];
    this.scanTopLevel(blankCommentsAndStrings(sql, dialect), regex, (m) => {
      matches.push(m);
    });
    if (matches.length === 0) {
      return null;
    }
    return pick === "last" ? matches[matches.length - 1] : matches[0];
  }

  /**
   * Position and value of the statement's own LIMIT clause. `value` is null
   * when the clause holds a parameter placeholder instead of a literal.
   */
  private static findTopLevelLimit(
    sql: string
  ): { index: number; length: number; value: number | null } | null {
    const match = this.findTopLevelMatch(
      sql,
      /\(|\)|\blimit\s+(?:(\d+)|\$\d+|\?|@p\d+)/gi,
      "last"
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

  /** Position and value of the statement's own `SELECT TOP n` clause (SQL Server). */
  private static findTopLevelTop(
    sql: string
  ): { index: number; length: number; value: number } | null {
    const match = this.findTopLevelMatch(
      sql,
      /\(|\)|\bselect\s+top\s+(\d+)/gi,
      "first",
      "sqlserver"
    );
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
      this.findTopLevelMatch(
        sql,
        /\(|\)|\bunion\b|\bintersect\b|\bexcept\b/gi,
        "first",
        "sqlserver"
      ) !== null
    );
  }

  /**
   * Find the start index of a top-level trailing ORDER BY clause (not one
   * nested inside a subquery or a window function's OVER (...) clause).
   * Returns -1 if none exists.
   */
  private static findTopLevelOrderByIndex(sql: string): number {
    return (
      this.findTopLevelMatch(sql, /\(|\)|\border\s+by\b/gi, "last", "sqlserver")?.index ?? -1
    );
  }

  /**
   * Add or tighten the TOP clause of a SQL statement (SQL Server)
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
      const selectMatch = this.findTopLevelSelect(sqlWithoutSemicolon);
      const cteIndex = selectMatch !== null ? selectMatch.index : 0;
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

    // Add TOP to the statement's own SELECT — for a CTE that is the final
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
   */
  static applyMaxRows(sql: string, maxRows: number | undefined): string {
    if (!maxRows || !this.isSelectQuery(sql)) {
      return sql;
    }
    return this.applyLimitToQuery(sql, maxRows);
  }

  /**
   * Apply maxRows limit to a row-returning query using SQL Server TOP syntax
   */
  static applyMaxRowsForSQLServer(sql: string, maxRows: number | undefined): string {
    if (!maxRows || !this.isSelectQuery(sql)) {
      return sql;
    }
    return this.applyTopToQuery(sql, maxRows);
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
