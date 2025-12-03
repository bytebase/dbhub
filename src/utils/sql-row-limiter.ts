import { stripCommentsAndStrings } from "./sql-parser.js";

/**
 * Shared utility for applying row limits to SELECT queries only using database-native LIMIT clauses
 */
export class SQLRowLimiter {
  /**
   * Check if a SQL statement is a SELECT query that can benefit from row limiting
   * Only handles SELECT queries
   */
  static isSelectQuery(sql: string): boolean {
    const trimmed = sql.trim().toLowerCase();
    return trimmed.startsWith('select');
  }

  /**
   * Check if a SQL statement already has a LIMIT clause.
   * Strips comments and string literals first to avoid false positives.
   */
  static hasLimitClause(sql: string): boolean {
    // Strip comments and strings to avoid matching LIMIT inside them
    const cleanedSQL = stripCommentsAndStrings(sql);
    // Detect LIMIT clause - handles literal numbers and parameter placeholders ($1, ?, @p1)
    const limitRegex = /\blimit\s+(?:\d+|\$\d+|\?|@p\d+)/i;
    return limitRegex.test(cleanedSQL);
  }

  /**
   * Check if a SQL statement already has a TOP clause (SQL Server).
   * Strips comments and string literals first to avoid false positives.
   */
  static hasTopClause(sql: string): boolean {
    // Strip comments and strings to avoid matching TOP inside them
    const cleanedSQL = stripCommentsAndStrings(sql);
    // Simple regex to detect TOP clause - handles most common cases
    const topRegex = /\bselect\s+top\s+\d+/i;
    return topRegex.test(cleanedSQL);
  }

  /**
   * Extract existing LIMIT value from SQL if present.
   * Strips comments and string literals first to avoid false positives.
   */
  static extractLimitValue(sql: string): number | null {
    // Strip comments and strings to avoid matching LIMIT inside them
    const cleanedSQL = stripCommentsAndStrings(sql);
    const limitMatch = cleanedSQL.match(/\blimit\s+(\d+)/i);
    if (limitMatch) {
      return parseInt(limitMatch[1], 10);
    }
    return null;
  }

  /**
   * Extract existing TOP value from SQL if present (SQL Server).
   * Strips comments and string literals first to avoid false positives.
   */
  static extractTopValue(sql: string): number | null {
    // Strip comments and strings to avoid matching TOP inside them
    const cleanedSQL = stripCommentsAndStrings(sql);
    const topMatch = cleanedSQL.match(/\bselect\s+top\s+(\d+)/i);
    if (topMatch) {
      return parseInt(topMatch[1], 10);
    }
    return null;
  }

  /**
   * Add or modify LIMIT clause in a SQL statement
   */
  static applyLimitToQuery(sql: string, maxRows: number): string {
    const existingLimit = this.extractLimitValue(sql);
    
    if (existingLimit !== null) {
      // Use the minimum of existing limit and maxRows
      const effectiveLimit = Math.min(existingLimit, maxRows);
      return sql.replace(/\blimit\s+\d+/i, `LIMIT ${effectiveLimit}`);
    } else {
      // Add LIMIT clause to the end of the query
      // Handle semicolon at the end
      const trimmed = sql.trim();
      const hasSemicolon = trimmed.endsWith(';');
      const sqlWithoutSemicolon = hasSemicolon ? trimmed.slice(0, -1) : trimmed;
      
      return `${sqlWithoutSemicolon} LIMIT ${maxRows}${hasSemicolon ? ';' : ''}`;
    }
  }

  /**
   * Add or modify TOP clause in a SQL statement (SQL Server)
   */
  static applyTopToQuery(sql: string, maxRows: number): string {
    const existingTop = this.extractTopValue(sql);
    
    if (existingTop !== null) {
      // Use the minimum of existing top and maxRows
      const effectiveTop = Math.min(existingTop, maxRows);
      return sql.replace(/\bselect\s+top\s+\d+/i, `SELECT TOP ${effectiveTop}`);
    } else {
      // Add TOP clause after SELECT
      return sql.replace(/\bselect\s+/i, `SELECT TOP ${maxRows} `);
    }
  }

  /**
   * Check if a LIMIT clause uses a parameter placeholder (not a literal number).
   * Strips comments and string literals first to avoid false positives.
   */
  static hasParameterizedLimit(sql: string): boolean {
    // Strip comments and strings to avoid matching LIMIT inside them
    const cleanedSQL = stripCommentsAndStrings(sql);
    // Check for parameterized LIMIT (excluding literal numbers)
    const parameterizedLimitRegex = /\blimit\s+(?:\$\d+|\?|@p\d+)/i;
    return parameterizedLimitRegex.test(cleanedSQL);
  }

  /**
   * Apply maxRows limit to a SELECT query only
   *
   * This method is used by PostgreSQL, MySQL, MariaDB, and SQLite connectors which all support
   * the LIMIT clause syntax. SQL Server uses applyMaxRowsForSQLServer() instead with TOP syntax.
   *
   * For parameterized LIMIT clauses (e.g., LIMIT $1 or LIMIT ?), we wrap the query in a subquery
   * to enforce max_rows as a hard cap, since the parameter value is not known until runtime.
   */
  static applyMaxRows(sql: string, maxRows: number | undefined): string {
    if (!maxRows || !this.isSelectQuery(sql)) {
      return sql;
    }

    // If query has a parameterized LIMIT, wrap it in a subquery with maxRows
    // This ensures max_rows is respected even when user provides a large parameter value
    if (this.hasParameterizedLimit(sql)) {
      // Wrap the query: SELECT * FROM (original_query) AS subq LIMIT max_rows
      // Note: Subquery wrapping is safe for PostgreSQL, MySQL, MariaDB, and SQLite
      const trimmed = sql.trim();
      const hasSemicolon = trimmed.endsWith(';');
      const sqlWithoutSemicolon = hasSemicolon ? trimmed.slice(0, -1) : trimmed;
      return `SELECT * FROM (${sqlWithoutSemicolon}) AS subq LIMIT ${maxRows}${hasSemicolon ? ';' : ''}`;
    }

    // For literal LIMIT values, apply the minimum logic
    return this.applyLimitToQuery(sql, maxRows);
  }

  /**
   * Apply maxRows limit to a SELECT query using SQL Server TOP syntax
   */
  static applyMaxRowsForSQLServer(sql: string, maxRows: number | undefined): string {
    if (!maxRows || !this.isSelectQuery(sql)) {
      return sql;
    }
    return this.applyTopToQuery(sql, maxRows);
  }
}