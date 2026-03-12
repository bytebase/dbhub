import { describe, it, expect } from "vitest";
import { isReadOnlySQL } from "../allowed-keywords.js";

describe("isReadOnlySQL", () => {
  describe("basic read-only detection", () => {
    it("should identify SELECT as read-only", () => {
      expect(isReadOnlySQL("SELECT * FROM users", "postgres")).toBe(true);
    });

    it("should identify WITH as read-only", () => {
      expect(isReadOnlySQL("WITH cte AS (SELECT 1) SELECT * FROM cte", "postgres")).toBe(true);
    });

    it("should identify EXPLAIN as read-only", () => {
      expect(isReadOnlySQL("EXPLAIN SELECT * FROM users", "postgres")).toBe(true);
    });

    it("should identify INSERT as not read-only", () => {
      expect(isReadOnlySQL("INSERT INTO users VALUES (1)", "postgres")).toBe(false);
    });

    it("should identify UPDATE as not read-only", () => {
      expect(isReadOnlySQL("UPDATE users SET name = 'test'", "postgres")).toBe(false);
    });

    it("should identify DELETE as not read-only", () => {
      expect(isReadOnlySQL("DELETE FROM users", "postgres")).toBe(false);
    });
  });

  describe("comment handling", () => {
    it("should detect read-only after stripping single-line comment", () => {
      const sql = "-- this is a comment\nSELECT * FROM users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should detect read-only after stripping multi-line comment", () => {
      const sql = "/* INSERT */ SELECT * FROM users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should detect non-read-only after stripping comment with SELECT", () => {
      const sql = "/* SELECT */ INSERT INTO users VALUES (1)";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should handle commented-out destructive statement before real read-only", () => {
      const sql = "-- DELETE FROM users\nSELECT * FROM users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });
  });

  describe("database-specific keywords", () => {
    it("should recognize SHOW as read-only for MySQL", () => {
      expect(isReadOnlySQL("SHOW TABLES", "mysql")).toBe(true);
    });

    it("should recognize DESCRIBE as read-only for MySQL", () => {
      expect(isReadOnlySQL("DESCRIBE users", "mysql")).toBe(true);
    });

    it("should recognize PRAGMA as read-only for SQLite", () => {
      expect(isReadOnlySQL("PRAGMA table_info(users)", "sqlite")).toBe(true);
    });

    it("should not recognize SHOW as read-only for SQLite", () => {
      expect(isReadOnlySQL("SHOW TABLES", "sqlite")).toBe(false);
    });
  });

  describe("CTE with mutating operations", () => {
    it("should reject UPDATE inside a CTE", () => {
      const sql = "WITH updated AS (UPDATE contracts SET site_location_postcode = 'SW11' WHERE id = 1 RETURNING id) SELECT * FROM updated";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should reject DELETE inside a CTE", () => {
      const sql = "WITH deleted AS (DELETE FROM users WHERE id = 1 RETURNING *) SELECT * FROM deleted";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should reject INSERT inside a CTE", () => {
      const sql = "WITH inserted AS (INSERT INTO users (name) VALUES ('test') RETURNING *) SELECT * FROM inserted";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should allow a pure SELECT CTE", () => {
      const sql = "WITH cte AS (SELECT * FROM users) SELECT * FROM cte";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should reject DROP inside a CTE-like construct", () => {
      const sql = "WITH x AS (SELECT 1) DROP TABLE users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should not be fooled by mutating keywords in string literals", () => {
      const sql = "SELECT * FROM users WHERE name = 'UPDATE me'";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should not be fooled by mutating keywords in comments", () => {
      const sql = "/* UPDATE users SET x = 1 */ SELECT * FROM users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should treat empty SQL after comment stripping as read-only", () => {
      expect(isReadOnlySQL("-- just a comment", "postgres")).toBe(true);
    });

    it("should be case-insensitive", () => {
      expect(isReadOnlySQL("select * from users", "postgres")).toBe(true);
      expect(isReadOnlySQL("SELECT * FROM users", "postgres")).toBe(true);
    });
  });
});
