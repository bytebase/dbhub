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
      expect(result).toBe("SELECT * FROM users LIMIT 100");
    });

    it("should wrap parameterized LIMIT in subquery to enforce max_rows (PostgreSQL)", () => {
      const sql = "SELECT * FROM users WHERE name = $1 LIMIT $2";
      const result = SQLRowLimiter.applyMaxRows(sql, 1000);
      // Should wrap in subquery to enforce max_rows as hard cap
      expect(result).toBe("SELECT * FROM (SELECT * FROM users WHERE name = $1 LIMIT $2) AS subq LIMIT 1000");
    });

    it("should wrap parameterized LIMIT in subquery to enforce max_rows (MySQL)", () => {
      const sql = "SELECT * FROM users WHERE name = ? LIMIT ?";
      const result = SQLRowLimiter.applyMaxRows(sql, 1000);
      expect(result).toBe("SELECT * FROM (SELECT * FROM users WHERE name = ? LIMIT ?) AS subq LIMIT 1000");
    });

    it("should wrap parameterized LIMIT in subquery to enforce max_rows (named parameters)", () => {
      // Note: @p style parameters with LIMIT is not valid SQL Server syntax
      // (SQL Server uses TOP, not LIMIT). This tests the regex pattern only.
      const sql = "SELECT * FROM users WHERE name = @p1 LIMIT @p2";
      const result = SQLRowLimiter.applyMaxRows(sql, 1000);
      expect(result).toBe("SELECT * FROM (SELECT * FROM users WHERE name = @p1 LIMIT @p2) AS subq LIMIT 1000");
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
      expect(result).toBe("SELECT * FROM (SELECT emp_no, first_name, last_name, hire_date FROM employee WHERE first_name ILIKE '%' || $1 || '%' OR last_name ILIKE '%' || $1 || '%' LIMIT $2) AS subq LIMIT 1000");
    });

    it("should preserve semicolon at end when adding LIMIT", () => {
      const sql = "SELECT * FROM users;";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users LIMIT 100;");
    });

    it("should preserve semicolon when wrapping parameterized LIMIT (PostgreSQL)", () => {
      const sql = "SELECT * FROM users WHERE name = $1 LIMIT $2;";
      const result = SQLRowLimiter.applyMaxRows(sql, 1000);
      expect(result).toBe("SELECT * FROM (SELECT * FROM users WHERE name = $1 LIMIT $2) AS subq LIMIT 1000;");
    });

    it("should preserve semicolon when wrapping parameterized LIMIT (MySQL)", () => {
      const sql = "SELECT * FROM users WHERE name = ? LIMIT ?;";
      const result = SQLRowLimiter.applyMaxRows(sql, 1000);
      expect(result).toBe("SELECT * FROM (SELECT * FROM users WHERE name = ? LIMIT ?) AS subq LIMIT 1000;");
    });

    it("should preserve semicolon when wrapping parameterized LIMIT (named parameters)", () => {
      // Note: @p style parameters with LIMIT is not valid SQL Server syntax
      // (SQL Server uses TOP, not LIMIT). This tests the regex pattern only.
      const sql = "SELECT * FROM users WHERE name = @p1 LIMIT @p2;";
      const result = SQLRowLimiter.applyMaxRows(sql, 1000);
      expect(result).toBe("SELECT * FROM (SELECT * FROM users WHERE name = @p1 LIMIT @p2) AS subq LIMIT 1000;");
    });

    it("should add LIMIT when 'limit' only appears in string literal", () => {
      const sql = "SELECT 'show limit 10 records' AS msg FROM users";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT 'show limit 10 records' AS msg FROM users LIMIT 100");
    });

    it("should add LIMIT when 'limit' only appears in comment", () => {
      const sql = "SELECT * FROM users /* limit 10 */";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users /* limit 10 */ LIMIT 100");
    });

    it("should add LIMIT when 'limit' only appears in single-line comment", () => {
      const sql = "SELECT * FROM users -- limit 10";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users -- limit 10 LIMIT 100");
    });
  });
});
