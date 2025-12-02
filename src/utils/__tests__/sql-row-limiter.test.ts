import { describe, it, expect } from "vitest";
import { SQLRowLimiter } from "../sql-row-limiter.js";

describe("SQLRowLimiter", () => {
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

    it("should detect LIMIT with SQL Server parameter (@p1, @p2, etc.)", () => {
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

    it("should wrap parameterized LIMIT in subquery to enforce max_rows (SQL Server)", () => {
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

    it("should preserve semicolon when wrapping parameterized LIMIT (SQL Server)", () => {
      const sql = "SELECT * FROM users WHERE name = @p1 LIMIT @p2;";
      const result = SQLRowLimiter.applyMaxRows(sql, 1000);
      expect(result).toBe("SELECT * FROM (SELECT * FROM users WHERE name = @p1 LIMIT @p2) AS subq LIMIT 1000;");
    });
  });
});
