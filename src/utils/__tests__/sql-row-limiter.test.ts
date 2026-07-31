import { describe, it, expect } from "vitest";
import { SQLRowLimiter } from "../sql-row-limiter.js";

describe("SQLRowLimiter", () => {
  describe("hasLimitClause - edge cases with comments and strings", () => {
    it("should not detect LIMIT inside single-quoted string", () => {
      const sql = "SELECT 'show limit 10 records' AS msg FROM users";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(false);
    });

    it("should not detect LIMIT inside double-quoted identifier", () => {
      const sql = 'SELECT "limit 10" AS col FROM users';
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(false);
    });

    it("should not detect LIMIT inside single-line comment", () => {
      const sql = "SELECT * FROM users -- limit 10\nWHERE active = true";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(false);
    });

    it("should not detect LIMIT inside multi-line comment", () => {
      const sql = "SELECT * FROM users /* limit 10 */ WHERE active = true";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(false);
    });

    it("should detect real LIMIT after string containing 'limit'", () => {
      const sql = "SELECT 'limit' AS word FROM users LIMIT 10";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(true);
    });

    it("should detect real LIMIT after comment containing 'limit'", () => {
      const sql = "SELECT * FROM users /* show limit */ LIMIT 10";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(true);
    });

    it("should handle escaped quotes in strings", () => {
      const sql = "SELECT 'it''s limit 10' AS msg FROM users";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(false);
    });
  });

  describe("hasLimitClause", () => {
    it("should detect LIMIT with literal number", () => {
      const sql = "SELECT * FROM users LIMIT 10";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(true);
    });

    it("should detect LIMIT with PostgreSQL parameter ($1, $2, etc.)", () => {
      const sql = "SELECT * FROM users WHERE name = $1 LIMIT $2";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(true);
    });

    it("should detect LIMIT with MySQL/SQLite parameter (?)", () => {
      const sql = "SELECT * FROM users WHERE name = ? LIMIT ?";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(true);
    });

    it("should detect LIMIT with named parameter (@p1, @p2, etc.)", () => {
      // Note: @p style parameters with LIMIT is not valid SQL Server syntax
      // (SQL Server uses TOP, not LIMIT). This tests the regex pattern only.
      const sql = "SELECT * FROM users WHERE name = @p1 LIMIT @p2";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(true);
    });

    it("should return false when no LIMIT clause exists", () => {
      const sql = "SELECT * FROM users WHERE active = true";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(false);
    });
  });

  describe("applyMaxRows", () => {
    it("should not modify SQL when maxRows is undefined", () => {
      const sql = "SELECT * FROM users";
      expect(SQLRowLimiter.applyMaxRows(sql, undefined)).toBe(sql);
    });

    it("should not modify non-SELECT queries", () => {
      const sql = "UPDATE users SET active = true";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(sql);
    });

    it("should add LIMIT when none exists", () => {
      const sql = "SELECT * FROM users";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users\nLIMIT 100");
    });

    // Note: @p style parameters with LIMIT is not valid SQL Server syntax
    // (SQL Server uses TOP, not LIMIT). The @p cases test the regex pattern only.
    it.each([
      { label: "PostgreSQL", p1: "$1", p2: "$2", semi: "" },
      { label: "MySQL", p1: "?", p2: "?", semi: "" },
      { label: "named parameters", p1: "@p1", p2: "@p2", semi: "" },
      { label: "PostgreSQL, trailing semicolon", p1: "$1", p2: "$2", semi: ";" },
      { label: "MySQL, trailing semicolon", p1: "?", p2: "?", semi: ";" },
      { label: "named parameters, trailing semicolon", p1: "@p1", p2: "@p2", semi: ";" },
    ])("should wrap parameterized LIMIT in subquery to enforce max_rows ($label)", ({ p1, p2, semi }) => {
      const sql = `SELECT * FROM users WHERE name = ${p1} LIMIT ${p2}${semi}`;
      const result = SQLRowLimiter.applyMaxRows(sql, 1000);
      // Should wrap in subquery to enforce max_rows as hard cap
      expect(result).toBe(
        `SELECT * FROM (SELECT * FROM users WHERE name = ${p1} LIMIT ${p2}\n) AS subq LIMIT 1000${semi}`
      );
    });

    it("should use minimum of existing LIMIT and maxRows", () => {
      const sql = "SELECT * FROM users LIMIT 50";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users LIMIT 50");
    });

    it("should replace existing LIMIT when maxRows is smaller", () => {
      const sql = "SELECT * FROM users LIMIT 200";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users LIMIT 100");
    });

    it("should handle complex query with parameterized LIMIT", () => {
      const sql = "SELECT emp_no, first_name, last_name, hire_date FROM employee WHERE first_name ILIKE '%' || $1 || '%' OR last_name ILIKE '%' || $1 || '%' LIMIT $2";
      const result = SQLRowLimiter.applyMaxRows(sql, 1000);
      // Should wrap in subquery to enforce max_rows
      expect(result).toBe("SELECT * FROM (SELECT emp_no, first_name, last_name, hire_date FROM employee WHERE first_name ILIKE '%' || $1 || '%' OR last_name ILIKE '%' || $1 || '%' LIMIT $2\n) AS subq LIMIT 1000");
    });

    it("should preserve semicolon at end when adding LIMIT", () => {
      const sql = "SELECT * FROM users;";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users\nLIMIT 100;");
    });

    it("should add LIMIT when 'limit' only appears in string literal", () => {
      const sql = "SELECT 'show limit 10 records' AS msg FROM users";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT 'show limit 10 records' AS msg FROM users\nLIMIT 100");
    });

    it("should add LIMIT when 'limit' only appears in comment", () => {
      const sql = "SELECT * FROM users /* limit 10 */";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users /* limit 10 */\nLIMIT 100");
    });

    it("adds an effective LIMIT even when the query ends in a -- line comment", () => {
      // The LIMIT is appended on a new line so a trailing `--` comment cannot
      // swallow it (a same-line append would leave the cap inert).
      const sql = "SELECT * FROM users -- limit 10";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users -- limit 10\nLIMIT 100");
    });

    it("keeps the subquery wrap syntactically valid when the inner query ends in a -- line comment", () => {
      const sql = "SELECT * FROM users LIMIT ? -- cap";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM (SELECT * FROM users LIMIT ? -- cap\n) AS subq LIMIT 100");
    });
  });

  describe("applyMaxRowsForSQLServer", () => {
    it("should not modify SQL when maxRows is undefined", () => {
      const sql = "SELECT * FROM users";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, undefined)).toBe(sql);
    });

    it("should add TOP when none exists", () => {
      const sql = "SELECT * FROM users";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100);
      expect(result).toBe("SELECT TOP 100 * FROM users");
    });

    it("should use minimum of existing TOP and maxRows", () => {
      const sql = "SELECT TOP 50 * FROM users";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100);
      expect(result).toBe("SELECT TOP 50 * FROM users");
    });

    it("should wrap UNION ALL queries so TOP caps the combined result set (issue #387)", () => {
      const sql =
        "SELECT 1 AS dbhub_row_cap_probe\nUNION ALL SELECT 2\nUNION ALL SELECT 3\nUNION ALL SELECT 4";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 3);
      expect(result).toBe(
        "SELECT TOP 3 * FROM (SELECT 1 AS dbhub_row_cap_probe\nUNION ALL SELECT 2\nUNION ALL SELECT 3\nUNION ALL SELECT 4\n) AS subq"
      );
    });

    it("should wrap UNION queries (without ALL) so TOP caps the combined result set", () => {
      const sql = "SELECT id FROM a UNION SELECT id FROM b";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 5);
      expect(result).toBe("SELECT TOP 5 * FROM (SELECT id FROM a UNION SELECT id FROM b\n) AS subq");
    });

    it("should wrap INTERSECT/EXCEPT queries so TOP caps the combined result set", () => {
      const sql = "SELECT id FROM a EXCEPT SELECT id FROM b";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 5);
      expect(result).toBe("SELECT TOP 5 * FROM (SELECT id FROM a EXCEPT SELECT id FROM b\n) AS subq");
    });

    it("should preserve trailing semicolon when wrapping a set-operator query", () => {
      const sql = "SELECT id FROM a UNION ALL SELECT id FROM b;";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 5);
      expect(result).toBe("SELECT TOP 5 * FROM (SELECT id FROM a UNION ALL SELECT id FROM b\n) AS subq;");
    });

    it("should not treat 'union' inside a string literal as a set operator", () => {
      const sql = "SELECT 'union all' AS msg FROM users";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100);
      expect(result).toBe("SELECT TOP 100 'union all' AS msg FROM users");
    });

    it("should still cap the combined result when TOP is only on the first branch of a UNION", () => {
      // A branch-level TOP only limits that branch's own rows, not the
      // combined UNION output, so the whole statement must still be wrapped
      // instead of just tightening the branch's TOP value.
      const sql = "SELECT TOP 50 id FROM a UNION ALL SELECT id FROM b";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 5);
      expect(result).toBe("SELECT TOP 5 * FROM (SELECT TOP 50 id FROM a UNION ALL SELECT id FROM b\n) AS subq");
    });

    it("should hoist a top-level trailing ORDER BY outside the wrapped subquery", () => {
      // T-SQL disallows ORDER BY inside a derived table unless that derived
      // table itself has TOP/OFFSET/FOR XML, so leaving it inside the wrap
      // would break the query.
      const sql = "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 3);
      expect(result).toBe(
        "SELECT TOP 3 * FROM (SELECT id FROM a UNION ALL SELECT id FROM b\n) AS subq ORDER BY id"
      );
    });

    it("should hoist a top-level trailing ORDER BY and preserve a trailing semicolon", () => {
      const sql = "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id;";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 3);
      expect(result).toBe(
        "SELECT TOP 3 * FROM (SELECT id FROM a UNION ALL SELECT id FROM b\n) AS subq ORDER BY id;"
      );
    });

    it("should not mistake an ORDER BY inside a window function's OVER clause for a top-level ORDER BY", () => {
      const sql =
        "SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM a UNION ALL SELECT id, ROW_NUMBER() OVER (ORDER BY id) FROM b";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 3);
      expect(result).toBe(`SELECT TOP 3 * FROM (${sql}\n) AS subq`);
    });

    it("should not re-wrap a UNION already nested inside a derived table", () => {
      // The union here is nested one level deep in parentheses, so the outer
      // query is a plain SELECT with its own genuine top-level TOP — that
      // TOP should just be tightened, not treated as a per-branch TOP.
      const sql = "SELECT TOP 50 * FROM (SELECT id FROM a UNION ALL SELECT id FROM b) AS t";
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 5);
      expect(result).toBe("SELECT TOP 5 * FROM (SELECT id FROM a UNION ALL SELECT id FROM b) AS t");
    });
  });
});
