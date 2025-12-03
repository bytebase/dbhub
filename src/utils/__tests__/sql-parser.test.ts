import { describe, it, expect } from "vitest";
import { stripCommentsAndStrings } from "../sql-parser.js";

describe("stripCommentsAndStrings", () => {
  describe("single-line comments (--)", () => {
    it("should strip single-line comment at end of line", () => {
      const sql = "SELECT * FROM users -- comment";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM users  ");
    });

    it("should strip single-line comment and preserve next line", () => {
      const sql = "SELECT * FROM users -- comment\nWHERE active = true";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM users  \nWHERE active = true");
    });

    it("should handle multiple single-line comments", () => {
      const sql = "SELECT * -- first\nFROM users -- second";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT *  \nFROM users  ");
    });
  });

  describe("multi-line comments (/* */)", () => {
    it("should strip inline multi-line comment", () => {
      const sql = "SELECT * /* comment */ FROM users";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT *   FROM users");
    });

    it("should strip multi-line comment spanning lines", () => {
      const sql = "SELECT * /* multi\nline\ncomment */ FROM users";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT *   FROM users");
    });

    it("should handle multiple multi-line comments", () => {
      const sql = "SELECT /* a */ * /* b */ FROM users";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT   *   FROM users");
    });
  });

  describe("single-quoted strings", () => {
    it("should strip simple single-quoted string", () => {
      const sql = "SELECT 'hello' AS msg";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT   AS msg");
    });

    it("should strip string containing SQL keywords", () => {
      const sql = "SELECT 'SELECT * FROM evil' AS msg";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT   AS msg");
    });

    it("should handle escaped single quotes", () => {
      const sql = "SELECT 'it''s escaped' AS msg";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT   AS msg");
    });

    it("should handle multiple strings", () => {
      const sql = "SELECT 'a', 'b', 'c' FROM test";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT  ,  ,   FROM test");
    });

    it("should handle string with parameter-like content", () => {
      const sql = "SELECT '$1 is the price' AS msg";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT   AS msg");
    });
  });

  describe("double-quoted identifiers", () => {
    it("should strip double-quoted identifier", () => {
      const sql = 'SELECT * FROM "my table"';
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM  ");
    });

    it("should handle escaped double quotes", () => {
      const sql = 'SELECT * FROM "table""name"';
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM  ");
    });

    it("should handle identifier with special chars", () => {
      const sql = 'SELECT * FROM "table-with-dashes"';
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM  ");
    });
  });

  describe("mixed comments and strings", () => {
    it("should handle comment inside string (keeps comment in original SQL)", () => {
      // The string '/* not a comment */' is stripped, but the content doesn't matter
      const sql = "SELECT '/* not a comment */' AS msg";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT   AS msg");
    });

    it("should handle string after comment", () => {
      const sql = "SELECT /* comment */ 'value' AS msg";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT     AS msg");
    });

    it("should handle complex mixed SQL", () => {
      const sql = `
        SELECT 'text with $1' AS a, /* comment with $2 */ col
        FROM users -- comment with $3
        WHERE id = $1
      `;
      const result = stripCommentsAndStrings(sql);
      expect(result).toContain("WHERE id = $1");
      expect(result).not.toContain("text with $1");
      expect(result).not.toContain("comment with $2");
      expect(result).not.toContain("comment with $3");
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      expect(stripCommentsAndStrings("")).toBe("");
    });

    it("should handle SQL with no comments or strings", () => {
      const sql = "SELECT * FROM users WHERE id = 1";
      expect(stripCommentsAndStrings(sql)).toBe(sql);
    });

    it("should handle unclosed string gracefully", () => {
      const sql = "SELECT 'unclosed";
      // Should not throw, just process what it can
      expect(stripCommentsAndStrings(sql)).toBe("SELECT  ");
    });

    it("should handle unclosed comment gracefully", () => {
      const sql = "SELECT * /* unclosed";
      // Should not throw, just process what it can
      expect(stripCommentsAndStrings(sql)).toBe("SELECT *  ");
    });
  });
});
