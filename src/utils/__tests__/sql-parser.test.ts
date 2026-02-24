import { describe, it, expect } from "vitest";
import { stripCommentsAndStrings, splitSQLStatements } from "../sql-parser.js";

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

    it("should handle nested block comments in PostgreSQL", () => {
      const sql = "SELECT /* outer /* inner */ still comment */ 1";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("SELECT   1");
    });

    it("should NOT handle nested block comments in non-PostgreSQL dialects", () => {
      // Non-nested scanner closes at the first */, leaving "still comment */" as plain text
      const sql = "SELECT /* outer /* inner */ still comment */ 1";
      expect(stripCommentsAndStrings(sql, "mysql")).toBe("SELECT   still comment */ 1");
    });

    it("should handle deeply nested block comments in PostgreSQL", () => {
      const sql = "SELECT /* a /* b /* c */ b */ a */ 1";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("SELECT   1");
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

    it("should handle unclosed double-quoted identifier gracefully", () => {
      const sql = 'SELECT * FROM "unclosed';
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM  ");
    });
  });

  describe("dollar-quoted blocks (PostgreSQL)", () => {
    it("should strip $$ block", () => {
      const sql = "DO $$ BEGIN RAISE NOTICE 'test'; END; $$";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("DO  ");
    });

    it("should strip $tag$ block", () => {
      const sql = "DO $body$ BEGIN RAISE NOTICE 'test'; END; $body$";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("DO  ");
    });

    it("should strip block containing semicolons and keywords", () => {
      const sql = "CREATE FUNCTION foo() RETURNS void AS $$ DELETE FROM bar; INSERT INTO baz VALUES (1); $$ LANGUAGE plpgsql";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("CREATE FUNCTION foo() RETURNS void AS   LANGUAGE plpgsql");
    });

    it("should NOT consume $1 parameters as dollar-quotes", () => {
      const sql = "SELECT $1, $2 FROM users WHERE id = $3";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("SELECT $1, $2 FROM users WHERE id = $3");
    });

    it("should NOT consume $123 as dollar-quote", () => {
      const sql = "INSERT INTO t VALUES ($1, $22, $333)";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("INSERT INTO t VALUES ($1, $22, $333)");
    });

    it("should handle unclosed dollar-quote gracefully", () => {
      const sql = "DO $$ BEGIN RAISE NOTICE 'oops'";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("DO  ");
    });

    it("should handle $tag$ with underscore in tag name", () => {
      const sql = "DO $fn_body$ SELECT 1; $fn_body$";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("DO  ");
    });

    it("should handle dollar-quote after other content", () => {
      const sql = "SELECT 1; DO $$ BEGIN NULL; END; $$";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("SELECT 1; DO  ");
    });

    it("should handle adjacent dollar-quoted blocks", () => {
      const sql = "SELECT $$a$$, $$b$$";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("SELECT  ,  ");
    });

    it("should handle $tag$ with digits after first char", () => {
      const sql = "DO $tag1$ body; $tag1$";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("DO  ");
    });

    it("should not close $outer$ block on $$ inside it", () => {
      const sql = "DO $outer$ x := 'text; with $$ inside'; $outer$; SELECT 1";
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("DO  ; SELECT 1");
    });

    it("should NOT recognize dollar-quoting for MySQL dialect", () => {
      const sql = "SELECT $$a$$";
      // MySQL doesn't have dollar-quoting — $$ should pass through as plain text
      expect(stripCommentsAndStrings(sql, "mysql")).toBe("SELECT $$a$$");
    });

    it("should NOT recognize dollar-quoting for SQL Server dialect", () => {
      const sql = "SELECT $$a$$";
      expect(stripCommentsAndStrings(sql, "sqlserver")).toBe("SELECT $$a$$");
    });
  });

  describe("backtick-quoted identifiers (MySQL/MariaDB/SQLite)", () => {
    it("should strip backtick-quoted identifier for MySQL", () => {
      const sql = "SELECT * FROM `my table`";
      expect(stripCommentsAndStrings(sql, "mysql")).toBe("SELECT * FROM  ");
    });

    it("should strip backtick-quoted identifier for MariaDB", () => {
      const sql = "SELECT * FROM `my table`";
      expect(stripCommentsAndStrings(sql, "mariadb")).toBe("SELECT * FROM  ");
    });

    it("should strip backtick-quoted identifier for SQLite", () => {
      const sql = "SELECT * FROM `my table`";
      expect(stripCommentsAndStrings(sql, "sqlite")).toBe("SELECT * FROM  ");
    });

    it("should handle escaped backticks", () => {
      const sql = "SELECT * FROM `table``name`";
      expect(stripCommentsAndStrings(sql, "mysql")).toBe("SELECT * FROM  ");
    });

    it("should handle backtick identifier with keywords inside", () => {
      const sql = "SELECT `SELECT` FROM `FROM`";
      expect(stripCommentsAndStrings(sql, "mysql")).toBe("SELECT   FROM  ");
    });

    it("should handle unclosed backtick gracefully", () => {
      const sql = "SELECT * FROM `unclosed";
      expect(stripCommentsAndStrings(sql, "mysql")).toBe("SELECT * FROM  ");
    });

    it("should NOT recognize backticks for PostgreSQL dialect", () => {
      const sql = "SELECT * FROM `my table`";
      // PostgreSQL doesn't use backtick quoting — backticks pass through as plain text
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("SELECT * FROM `my table`");
    });

    it("should NOT recognize backticks for SQL Server dialect", () => {
      const sql = "SELECT * FROM `my table`";
      expect(stripCommentsAndStrings(sql, "sqlserver")).toBe("SELECT * FROM `my table`");
    });
  });

  describe("bracket-quoted identifiers (SQL Server/SQLite)", () => {
    it("should strip bracket-quoted identifier for SQL Server", () => {
      const sql = "SELECT * FROM [my table]";
      expect(stripCommentsAndStrings(sql, "sqlserver")).toBe("SELECT * FROM  ");
    });

    it("should strip bracket-quoted identifier for SQLite", () => {
      const sql = "SELECT * FROM [my table]";
      expect(stripCommentsAndStrings(sql, "sqlite")).toBe("SELECT * FROM  ");
    });

    it("should handle escaped brackets (]] inside bracket identifier)", () => {
      const sql = "SELECT * FROM [table]]name]";
      expect(stripCommentsAndStrings(sql, "sqlserver")).toBe("SELECT * FROM  ");
    });

    it("should handle bracket identifier with keywords inside", () => {
      const sql = "SELECT [SELECT] FROM [FROM]";
      expect(stripCommentsAndStrings(sql, "sqlserver")).toBe("SELECT   FROM  ");
    });

    it("should handle unclosed bracket gracefully", () => {
      const sql = "SELECT * FROM [unclosed";
      expect(stripCommentsAndStrings(sql, "sqlserver")).toBe("SELECT * FROM  ");
    });

    it("should NOT recognize brackets for PostgreSQL dialect", () => {
      const sql = "SELECT * FROM [my table]";
      // PostgreSQL doesn't use bracket quoting — brackets pass through as plain text
      expect(stripCommentsAndStrings(sql, "postgres")).toBe("SELECT * FROM [my table]");
    });

    it("should NOT recognize brackets for MySQL dialect", () => {
      const sql = "SELECT * FROM [my table]";
      expect(stripCommentsAndStrings(sql, "mysql")).toBe("SELECT * FROM [my table]");
    });
  });

  describe("default dialect (no dialect specified — ANSI only)", () => {
    it("should NOT recognize dollar-quoting with no dialect", () => {
      const sql = "DO $$ BEGIN NULL; END; $$";
      // ANSI scanner doesn't know about dollar-quoting — $$ passes through as plain text
      expect(stripCommentsAndStrings(sql)).toBe("DO $$ BEGIN NULL; END; $$");
    });

    it("should NOT recognize backtick-quoting with no dialect", () => {
      const sql = "SELECT * FROM `my table`";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM `my table`");
    });

    it("should NOT recognize bracket-quoting with no dialect", () => {
      const sql = "SELECT * FROM [my table]";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT * FROM [my table]");
    });

    it("should still handle ANSI features (comments, single/double quotes)", () => {
      const sql = "SELECT 'text' FROM \"table\" -- comment";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT   FROM    ");
    });
  });

  describe("mixed comments and strings", () => {
    it("should handle comment inside string (keeps comment in original SQL)", () => {
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
      expect(stripCommentsAndStrings(sql)).toBe("SELECT  ");
    });

    it("should handle unclosed comment gracefully", () => {
      const sql = "SELECT * /* unclosed";
      expect(stripCommentsAndStrings(sql)).toBe("SELECT *  ");
    });
  });
});

describe("splitSQLStatements", () => {
  describe("basic splitting", () => {
    it("should return single statement without semicolon", () => {
      expect(splitSQLStatements("SELECT 1")).toEqual(["SELECT 1"]);
    });

    it("should return single statement with trailing semicolon", () => {
      expect(splitSQLStatements("SELECT 1;")).toEqual(["SELECT 1"]);
    });

    it("should split two statements", () => {
      expect(splitSQLStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("should handle trailing semicolons", () => {
      expect(splitSQLStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("should handle empty input", () => {
      expect(splitSQLStatements("")).toEqual([]);
    });

    it("should handle whitespace-only input", () => {
      expect(splitSQLStatements("   \n  \t  ")).toEqual([]);
    });

    it("should handle multiple semicolons with no content", () => {
      expect(splitSQLStatements(";;;")).toEqual([]);
    });

    it("should discard whitespace-only segments between statements", () => {
      expect(splitSQLStatements("SELECT 1; ; ; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("should trim statements", () => {
      expect(splitSQLStatements("  SELECT 1 ;  SELECT 2  ")).toEqual(["SELECT 1", "SELECT 2"]);
    });
  });

  describe("semicolons inside single-quoted strings", () => {
    it("should not split on semicolon inside string", () => {
      const sql = "SELECT 'hello; world'";
      expect(splitSQLStatements(sql)).toEqual(["SELECT 'hello; world'"]);
    });

    it("should handle escaped quotes with semicolons", () => {
      const sql = "SELECT 'it''s; complicated'";
      expect(splitSQLStatements(sql)).toEqual(["SELECT 'it''s; complicated'"]);
    });
  });

  describe("semicolons inside double-quoted identifiers", () => {
    it("should not split on semicolon inside double-quoted identifier", () => {
      const sql = 'SELECT * FROM "table; name"';
      expect(splitSQLStatements(sql)).toEqual(['SELECT * FROM "table; name"']);
    });
  });

  describe("semicolons inside dollar-quoted blocks (PostgreSQL)", () => {
    it("should not split on semicolons inside $$ block", () => {
      const sql = "DO $$ BEGIN RAISE NOTICE 'test'; END; $$";
      expect(splitSQLStatements(sql, "postgres")).toEqual(["DO $$ BEGIN RAISE NOTICE 'test'; END; $$"]);
    });

    it("should not split on semicolons inside $tag$ block", () => {
      const sql = "DO $body$ BEGIN RAISE NOTICE 'test'; END; $body$";
      expect(splitSQLStatements(sql, "postgres")).toEqual(["DO $body$ BEGIN RAISE NOTICE 'test'; END; $body$"]);
    });

    it("should split after dollar-quoted block ends", () => {
      const sql = "DO $$ BEGIN NULL; END; $$; SELECT 1";
      expect(splitSQLStatements(sql, "postgres")).toEqual([
        "DO $$ BEGIN NULL; END; $$",
        "SELECT 1",
      ]);
    });

    it("should NOT treat $1 as dollar-quote opening", () => {
      const sql = "SELECT $1; SELECT $2";
      expect(splitSQLStatements(sql, "postgres")).toEqual(["SELECT $1", "SELECT $2"]);
    });

    it("should handle adjacent dollar-quoted blocks", () => {
      const sql = "SELECT $$a$$, $$b$$; SELECT 1";
      expect(splitSQLStatements(sql, "postgres")).toEqual(["SELECT $$a$$, $$b$$", "SELECT 1"]);
    });

    it("should not close $outer$ on $$ inside it", () => {
      const sql = "DO $outer$ x := 'text; with $$ inside'; $outer$; SELECT 1";
      expect(splitSQLStatements(sql, "postgres")).toEqual([
        "DO $outer$ x := 'text; with $$ inside'; $outer$",
        "SELECT 1",
      ]);
    });
  });

  describe("semicolons inside backtick-quoted identifiers (MySQL/MariaDB/SQLite)", () => {
    it("should not split on semicolon inside backtick identifier (MySQL)", () => {
      const sql = "SELECT * FROM `table; name`; SELECT 1";
      expect(splitSQLStatements(sql, "mysql")).toEqual(["SELECT * FROM `table; name`", "SELECT 1"]);
    });

    it("should not split on semicolon inside backtick identifier (MariaDB)", () => {
      const sql = "SELECT * FROM `table; name`; SELECT 1";
      expect(splitSQLStatements(sql, "mariadb")).toEqual(["SELECT * FROM `table; name`", "SELECT 1"]);
    });

    it("should not split on semicolon inside backtick identifier (SQLite)", () => {
      const sql = "SELECT * FROM `table; name`; SELECT 1";
      expect(splitSQLStatements(sql, "sqlite")).toEqual(["SELECT * FROM `table; name`", "SELECT 1"]);
    });

    it("should handle escaped backticks with semicolons", () => {
      const sql = "SELECT * FROM `tab``le; name`; SELECT 1";
      expect(splitSQLStatements(sql, "mysql")).toEqual(["SELECT * FROM `tab``le; name`", "SELECT 1"]);
    });

    it("should split on semicolon inside backtick for PostgreSQL (not a backtick dialect)", () => {
      // PostgreSQL doesn't recognize backtick quoting, so the semicolon inside backticks IS a split point
      const sql = "SELECT * FROM `table; name`";
      expect(splitSQLStatements(sql, "postgres")).toEqual(["SELECT * FROM `table", "name`"]);
    });
  });

  describe("semicolons inside bracket-quoted identifiers (SQL Server/SQLite)", () => {
    it("should not split on semicolon inside bracket identifier (SQL Server)", () => {
      const sql = "SELECT * FROM [table; name]; SELECT 1";
      expect(splitSQLStatements(sql, "sqlserver")).toEqual(["SELECT * FROM [table; name]", "SELECT 1"]);
    });

    it("should not split on semicolon inside bracket identifier (SQLite)", () => {
      const sql = "SELECT * FROM [table; name]; SELECT 1";
      expect(splitSQLStatements(sql, "sqlite")).toEqual(["SELECT * FROM [table; name]", "SELECT 1"]);
    });

    it("should handle escaped brackets with semicolons", () => {
      const sql = "SELECT * FROM [table]]; name]; SELECT 1";
      expect(splitSQLStatements(sql, "sqlserver")).toEqual(["SELECT * FROM [table]]; name]", "SELECT 1"]);
    });

    it("should split on semicolon inside brackets for MySQL (not a bracket dialect)", () => {
      // MySQL doesn't recognize bracket quoting, so semicolons inside brackets ARE split points
      const sql = "SELECT * FROM [table; name]";
      expect(splitSQLStatements(sql, "mysql")).toEqual(["SELECT * FROM [table", "name]"]);
    });
  });

  describe("semicolons inside comments", () => {
    it("should not split on semicolon inside single-line comment", () => {
      const sql = "SELECT 1 -- this; has; semicolons\n; SELECT 2";
      expect(splitSQLStatements(sql)).toEqual([
        "SELECT 1 -- this; has; semicolons",
        "SELECT 2",
      ]);
    });

    it("should not split on semicolon inside block comment", () => {
      const sql = "SELECT 1 /* semi; colon; here */ ; SELECT 2";
      expect(splitSQLStatements(sql)).toEqual([
        "SELECT 1 /* semi; colon; here */",
        "SELECT 2",
      ]);
    });
  });

  describe("mixed quoting contexts", () => {
    it("should handle multiple quoting types in one statement", () => {
      const sql = `SELECT 'value with ;' FROM "table; name" WHERE x = $1; SELECT 2`;
      expect(splitSQLStatements(sql)).toEqual([
        `SELECT 'value with ;' FROM "table; name" WHERE x = $1`,
        "SELECT 2",
      ]);
    });

    it("should handle comments-only input with no executable SQL", () => {
      const sql = "-- just a comment\n/* another one */";
      expect(splitSQLStatements(sql)).toEqual(["-- just a comment\n/* another one */"]);
    });

    it("should handle SQLite with both backtick and bracket identifiers", () => {
      const sql = "SELECT `col; a` FROM [table; b]; SELECT 1";
      expect(splitSQLStatements(sql, "sqlite")).toEqual(["SELECT `col; a` FROM [table; b]", "SELECT 1"]);
    });
  });

  describe("realistic PostgreSQL examples", () => {
    it("should handle CREATE FUNCTION with dollar-quoting", () => {
      const sql = `
        CREATE OR REPLACE FUNCTION increment(i integer) RETURNS integer AS $$
          BEGIN
            RETURN i + 1;
          END;
        $$ LANGUAGE plpgsql;
        SELECT increment(1);
      `;
      const stmts = splitSQLStatements(sql, "postgres");
      expect(stmts).toHaveLength(2);
      expect(stmts[0]).toContain("CREATE OR REPLACE FUNCTION");
      expect(stmts[0]).toContain("RETURN i + 1;");
      expect(stmts[0]).toContain("$$ LANGUAGE plpgsql");
      expect(stmts[1]).toBe("SELECT increment(1)");
    });

    it("should handle DO block with dollar-quoting", () => {
      const sql = "DO $$ BEGIN RAISE NOTICE 'hello'; END; $$;";
      const stmts = splitSQLStatements(sql, "postgres");
      expect(stmts).toHaveLength(1);
      expect(stmts[0]).toBe("DO $$ BEGIN RAISE NOTICE 'hello'; END; $$");
    });

    it("should handle tagged dollar-quote in CREATE FUNCTION", () => {
      const sql = `
        CREATE FUNCTION test() RETURNS void AS $fn$
          DECLARE
            x integer;
          BEGIN
            x := 42;
            INSERT INTO log VALUES (x);
          END;
        $fn$ LANGUAGE plpgsql;
      `;
      const stmts = splitSQLStatements(sql, "postgres");
      expect(stmts).toHaveLength(1);
      expect(stmts[0]).toContain("$fn$");
      expect(stmts[0]).toContain("INSERT INTO log VALUES (x);");
    });

    it("should handle multiple function definitions", () => {
      const sql = `
        CREATE FUNCTION a() RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;
        CREATE FUNCTION b() RETURNS void AS $$ BEGIN NULL; END; $$ LANGUAGE plpgsql;
      `;
      const stmts = splitSQLStatements(sql, "postgres");
      expect(stmts).toHaveLength(2);
      expect(stmts[0]).toContain("FUNCTION a()");
      expect(stmts[1]).toContain("FUNCTION b()");
    });
  });

});
