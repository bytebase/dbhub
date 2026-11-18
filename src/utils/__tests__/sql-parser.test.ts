import { describe, it, expect } from "vitest";
import type { ConnectorType } from "../../connectors/interface.js";
import {
  stripCommentsAndStrings,
  stripCommentsAndStringsVariants,
  splitSQLStatements,
  splitSQLStatementVariants,
  blankCommentsAndStrings,
} from "../sql-parser.js";

describe("stripCommentsAndStrings", () => {
  describe("ANSI syntax (no dialect specified)", () => {
    it.each([
      ["multiple single-line comments", "SELECT * -- first\nFROM users -- second", "SELECT *  \nFROM users  "],
      ["a multi-line comment spanning lines", "SELECT * /* multi\nline\ncomment */ FROM users", "SELECT *   FROM users"],
      ["multiple multi-line comments", "SELECT /* a */ * /* b */ FROM users", "SELECT   *   FROM users"],
      ["escaped single quotes", "SELECT 'it''s escaped' AS msg", "SELECT   AS msg"],
      ["multiple strings", "SELECT 'a', 'b', 'c' FROM test", "SELECT  ,  ,   FROM test"],
      ["a double-quoted identifier", 'SELECT * FROM "my table"', "SELECT * FROM  "],
      ["escaped double quotes", 'SELECT * FROM "table""name"', "SELECT * FROM  "],
      ["a comment inside a string (part of the string)", "SELECT '/* not a comment */' AS msg", "SELECT   AS msg"],
      ["comments, single and double quotes together", "SELECT 'text' FROM \"table\" -- comment", "SELECT   FROM    "],
      ["an empty string", "", ""],
      ["SQL with no comments or strings", "SELECT * FROM users WHERE id = 1", "SELECT * FROM users WHERE id = 1"],
      ["an unclosed string", "SELECT 'unclosed", "SELECT  "],
      ["an unclosed double-quoted identifier", 'SELECT * FROM "unclosed', "SELECT * FROM  "],
      ["an unclosed comment", "SELECT * /* unclosed", "SELECT *  "],
      // The ANSI scanner knows none of the dialect quoting forms — each passes
      // through as plain text.
      ["dollar-quoting, left as plain text", "DO $$ BEGIN NULL; END; $$", "DO $$ BEGIN NULL; END; $$"],
      ["backtick-quoting, left as plain text", "SELECT * FROM `my table`", "SELECT * FROM `my table`"],
      ["bracket-quoting, left as plain text", "SELECT * FROM [my table]", "SELECT * FROM [my table]"],
    ])("should handle %s", (_label, sql, expected) => {
      expect(stripCommentsAndStrings(sql)).toBe(expected);
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

  describe("dialect-specific syntax", () => {
    it.each<[string, ConnectorType, string, string]>([
      // Block comments
      ["nested block comments", "postgres", "SELECT /* outer /* inner */ still comment */ 1", "SELECT   1"],
      // The non-nested scanner closes at the first */, leaving "still comment */" as plain text
      ["a block comment only up to its first */", "mysql", "SELECT /* outer /* inner */ still comment */ 1", "SELECT   still comment */ 1"],
      ["a regular comment", "mysql", "SELECT /* comment */ 1", "SELECT   1"],
      // PostgreSQL/SQLite/SQL Server don't execute conditional comments
      ["a MySQL conditional comment, which is an ordinary comment here", "postgres", "/*!50000 DELETE FROM users */", " "],
      ["a MySQL conditional comment, which is an ordinary comment here", "sqlite", "/*!50000 DELETE FROM users */", " "],
      ["a MySQL conditional comment, which is an ordinary comment here", "sqlserver", "/*!50000 DELETE FROM users */", " "],

      // Dollar-quoted blocks (PostgreSQL)
      ["a $$ block", "postgres", "DO $$ BEGIN RAISE NOTICE 'test'; END; $$", "DO  "],
      ["a $tag$ block", "postgres", "DO $body$ BEGIN RAISE NOTICE 'test'; END; $body$", "DO  "],
      [
        "a dollar-quoted block containing semicolons and keywords",
        "postgres",
        "CREATE FUNCTION foo() RETURNS void AS $$ DELETE FROM bar; INSERT INTO baz VALUES (1); $$ LANGUAGE plpgsql",
        "CREATE FUNCTION foo() RETURNS void AS   LANGUAGE plpgsql",
      ],
      ["$1 parameters, which are not dollar-quotes", "postgres", "SELECT $1, $2 FROM users WHERE id = $3", "SELECT $1, $2 FROM users WHERE id = $3"],
      ["an unclosed dollar-quote", "postgres", "DO $$ BEGIN RAISE NOTICE 'oops'", "DO  "],
      ["a $tag$ with an underscore in the tag name", "postgres", "DO $fn_body$ SELECT 1; $fn_body$", "DO  "],
      ["a dollar-quote after other content", "postgres", "SELECT 1; DO $$ BEGIN NULL; END; $$", "SELECT 1; DO  "],
      ["adjacent dollar-quoted blocks", "postgres", "SELECT $$a$$, $$b$$", "SELECT  ,  "],
      ["a $tag$ with digits after the first character", "postgres", "DO $tag1$ body; $tag1$", "DO  "],
      ["an $outer$ block that a $$ inside it does not close", "postgres", "DO $outer$ x := 'text; with $$ inside'; $outer$; SELECT 1", "DO  ; SELECT 1"],
      ["dollar-quoting, left as plain text", "mysql", "SELECT $$a$$", "SELECT $$a$$"],
      ["dollar-quoting, left as plain text", "sqlserver", "SELECT $$a$$", "SELECT $$a$$"],

      // Backtick-quoted identifiers (MySQL/MariaDB/SQLite)
      ["a backtick-quoted identifier", "mysql", "SELECT * FROM `my table`", "SELECT * FROM  "],
      ["a backtick-quoted identifier", "mariadb", "SELECT * FROM `my table`", "SELECT * FROM  "],
      ["a backtick-quoted identifier", "sqlite", "SELECT * FROM `my table`", "SELECT * FROM  "],
      ["escaped backticks", "mysql", "SELECT * FROM `table``name`", "SELECT * FROM  "],
      ["backtick identifiers with keywords inside", "mysql", "SELECT `SELECT` FROM `FROM`", "SELECT   FROM  "],
      ["an unclosed backtick", "mysql", "SELECT * FROM `unclosed", "SELECT * FROM  "],
      ["backticks, left as plain text", "postgres", "SELECT * FROM `my table`", "SELECT * FROM `my table`"],
      ["backticks, left as plain text", "sqlserver", "SELECT * FROM `my table`", "SELECT * FROM `my table`"],

      // Bracket-quoted identifiers (SQL Server/SQLite)
      ["a bracket-quoted identifier", "sqlserver", "SELECT * FROM [my table]", "SELECT * FROM  "],
      ["a bracket-quoted identifier", "sqlite", "SELECT * FROM [my table]", "SELECT * FROM  "],
      ["escaped brackets (]] inside a bracket identifier)", "sqlserver", "SELECT * FROM [table]]name]", "SELECT * FROM  "],
      ["bracket identifiers with keywords inside", "sqlserver", "SELECT [SELECT] FROM [FROM]", "SELECT   FROM  "],
      ["an unclosed bracket", "sqlserver", "SELECT * FROM [unclosed", "SELECT * FROM  "],
      ["brackets, left as plain text", "postgres", "SELECT * FROM [my table]", "SELECT * FROM [my table]"],
      ["brackets, left as plain text", "mysql", "SELECT * FROM [my table]", "SELECT * FROM [my table]"],

      // Alternative-quoted strings (Oracle q'...')
      ["q'[it's a ]test]'", "oracle", "SELECT q'[it's a ]test]' FROM dual", "SELECT   FROM dual"],
      ["Q'{a'b}'", "oracle", "SELECT Q'{a'b}' FROM dual", "SELECT   FROM dual"],
      ["q'<x>'", "oracle", "SELECT q'<x>' FROM dual", "SELECT   FROM dual"],
      ["q'!it's!'", "oracle", "SELECT q'!it's!' FROM dual", "SELECT   FROM dual"],
      ["a bare q identifier, which is not a quote opener", "oracle", "SELECT q, 'x' FROM t", "SELECT q,   FROM t"],
      ["an unterminated q-quote, which consumes the rest of the input", "oracle", "SELECT q'[oops FROM t", "SELECT  "],
    ])("should handle %s (%s)", (_label, dialect, sql, expected) => {
      expect(stripCommentsAndStrings(sql, dialect)).toBe(expected);
    });

    // Conditional comments (`/*!nnnnn ... */`) and MariaDB's `/*M! ... */` are
    // executable in MySQL and MariaDB — they must not be stripped.
    it.each([
      ["mysql", "SELECT 1; /*!50000 DELETE FROM users */"],
      ["mysql", "/*! DROP TABLE users */"],
      ["mariadb", "/*!50000 DELETE FROM users */"],
      ["mariadb", "SELECT 1; /*M! DROP TABLE users; DELETE FROM audit_log */"],
      ["mysql", "/*M! DELETE FROM users */"],
    ] as const)("should preserve an executable comment for %s: %s", (dialect, sql) => {
      expect(stripCommentsAndStrings(sql, dialect)).toBe(sql);
    });
  });
});

describe("splitSQLStatements", () => {
  describe("ANSI syntax (no dialect specified)", () => {
    it.each([
      ["single statement without semicolon", "SELECT 1", ["SELECT 1"]],
      ["single statement with trailing semicolon", "SELECT 1;", ["SELECT 1"]],
      ["two statements", "SELECT 1; SELECT 2", ["SELECT 1", "SELECT 2"]],
      ["empty input", "", []],
      ["whitespace-only segments between statements", "SELECT 1; ; ; SELECT 2", ["SELECT 1", "SELECT 2"]],
      ["surrounding whitespace (trimmed)", "  SELECT 1 ;  SELECT 2  ", ["SELECT 1", "SELECT 2"]],
      ["a semicolon inside a string", "SELECT 'hello; world'", ["SELECT 'hello; world'"]],
      ["escaped quotes with semicolons", "SELECT 'it''s; complicated'", ["SELECT 'it''s; complicated'"]],
      ["a semicolon inside a double-quoted identifier", 'SELECT * FROM "table; name"', ['SELECT * FROM "table; name"']],
      [
        "semicolons inside a single-line comment",
        "SELECT 1 -- this; has; semicolons\n; SELECT 2",
        ["SELECT 1 -- this; has; semicolons", "SELECT 2"],
      ],
      [
        "semicolons inside a block comment",
        "SELECT 1 /* semi; colon; here */ ; SELECT 2",
        ["SELECT 1 /* semi; colon; here */", "SELECT 2"],
      ],
      [
        "multiple quoting types in one statement",
        `SELECT 'value with ;' FROM "table; name" WHERE x = $1; SELECT 2`,
        [`SELECT 'value with ;' FROM "table; name" WHERE x = $1`, "SELECT 2"],
      ],
      [
        "comments-only input with no executable SQL",
        "-- just a comment\n/* another one */",
        ["-- just a comment\n/* another one */"],
      ],
    ])("should handle %s", (_label, sql, expected) => {
      expect(splitSQLStatements(sql)).toEqual(expected);
    });
  });

  describe("dialect-specific syntax", () => {
    // The scanners themselves are pinned under stripCommentsAndStrings; here
    // only the split-specific behaviour matters: no split inside a quoted
    // block, and splitting resumes once it closes.
    it.each<[string, ConnectorType, string, string[]]>([
      ["semicolons inside a $$ block", "postgres", "DO $$ BEGIN RAISE NOTICE 'test'; END; $$", ["DO $$ BEGIN RAISE NOTICE 'test'; END; $$"]],
      ["a statement after a dollar-quoted block ends", "postgres", "DO $$ BEGIN NULL; END; $$; SELECT 1", ["DO $$ BEGIN NULL; END; $$", "SELECT 1"]],
      [
        "semicolons inside a $tag$ function body",
        "postgres",
        "CREATE FUNCTION test() RETURNS void AS $fn$ BEGIN INSERT INTO log VALUES (1); END; $fn$ LANGUAGE plpgsql;",
        ["CREATE FUNCTION test() RETURNS void AS $fn$ BEGIN INSERT INTO log VALUES (1); END; $fn$ LANGUAGE plpgsql"],
      ],
      ["a semicolon inside a backtick identifier", "mysql", "SELECT * FROM `table; name`; SELECT 1", ["SELECT * FROM `table; name`", "SELECT 1"]],
      ["a semicolon inside a backtick identifier", "mariadb", "SELECT * FROM `table; name`; SELECT 1", ["SELECT * FROM `table; name`", "SELECT 1"]],
      ["a semicolon inside a backtick identifier", "sqlite", "SELECT * FROM `table; name`; SELECT 1", ["SELECT * FROM `table; name`", "SELECT 1"]],
      ["escaped backticks with semicolons", "mysql", "SELECT * FROM `tab``le; name`; SELECT 1", ["SELECT * FROM `tab``le; name`", "SELECT 1"]],
      // PostgreSQL doesn't recognize backtick quoting, so the semicolon inside backticks IS a split point
      ["a semicolon inside backticks, which is a split point here", "postgres", "SELECT * FROM `table; name`", ["SELECT * FROM `table", "name`"]],
      ["a semicolon inside a bracket identifier", "sqlserver", "SELECT * FROM [table; name]; SELECT 1", ["SELECT * FROM [table; name]", "SELECT 1"]],
      ["a semicolon inside a bracket identifier", "sqlite", "SELECT * FROM [table; name]; SELECT 1", ["SELECT * FROM [table; name]", "SELECT 1"]],
      ["escaped brackets with semicolons", "sqlserver", "SELECT * FROM [table]]; name]; SELECT 1", ["SELECT * FROM [table]]; name]", "SELECT 1"]],
      // MySQL doesn't recognize bracket quoting, so semicolons inside brackets ARE split points
      ["a semicolon inside brackets, which is a split point here", "mysql", "SELECT * FROM [table; name]", ["SELECT * FROM [table", "name]"]],
      ["both backtick and bracket identifiers", "sqlite", "SELECT `col; a` FROM [table; b]; SELECT 1", ["SELECT `col; a` FROM [table; b]", "SELECT 1"]],
      ["a semicolon inside a q-quote", "oracle", "SELECT q'[a;b]' FROM dual; SELECT 2 FROM dual", ["SELECT q'[a;b]' FROM dual", "SELECT 2 FROM dual"]],
    ])("should handle %s (%s)", (_label, dialect, sql, expected) => {
      expect(splitSQLStatements(sql, dialect)).toEqual(expected);
    });

    it("should handle a multi-line CREATE FUNCTION with dollar-quoting (postgres)", () => {
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
  });

  describe("MySQL/MariaDB dialect-aware -- comments", () => {
    it.each<[string, ConnectorType, string, number]>([
      // `--1;DROP...` is not a comment in MySQL, so the ; still splits.
      ["does not treat -- as a comment unless followed by whitespace/control/EOL", "mysql", "SELECT 1--1;DROP TABLE t", 2],
      ["does not treat -- as a comment unless followed by whitespace/control/EOL", "mariadb", "SELECT 1--1;DROP TABLE t", 2],
      ["treats '-- ' (whitespace) as a comment, swallowing the rest of the line", "mysql", "SELECT 1 -- c;DROP TABLE t", 1],
      // MySQL's lexer uses my_isspace() || my_iscntrl(); DEL is a control char.
      ["treats '--' followed by a control char (ASCII DEL 0x7F) as a comment", "mysql", "SELECT 1 --\x7Fc;DROP TABLE t", 1],
      ["keeps -- as an always-comment (dialect difference)", "postgres", "SELECT 1--1;DROP TABLE t", 1],
    ])("%s (%s)", (_label, dialect, sql, statementCount) => {
      expect(splitSQLStatements(sql, dialect)).toHaveLength(statementCount);
    });
  });
});

describe("blankCommentsAndStrings", () => {
  it("preserves the input length, unlike stripCommentsAndStrings", () => {
    const sql = "SELECT * FROM users -- a much longer comment than one space";
    const result = blankCommentsAndStrings(sql);
    expect(result).toHaveLength(sql.length);
    expect(result).toBe("SELECT * FROM users                                        ");
  });

  it("blanks single-line comments, multi-line comments, and string literals in place", () => {
    const sql = "SELECT 'it''s a test' /* note */ FROM users -- trailing";
    const result = blankCommentsAndStrings(sql);
    expect(result).toHaveLength(sql.length);
    expect(result).toBe("SELECT                           FROM users            ");
  });

  it("blanks SQL Server bracket-quoted identifiers when given the sqlserver dialect", () => {
    const sql = "SELECT [order] FROM [dbo].[users]";
    const result = blankCommentsAndStrings(sql, "sqlserver");
    expect(result).toHaveLength(sql.length);
    expect(result).toBe("SELECT         FROM      .       ");
  });
});

describe("backslash escapes in string literals", () => {
  const hidden = String.raw`SELECT '\' , '; DROP TABLE t; SELECT ''`;

  it("ends a MySQL/MariaDB string only at an unescaped quote", () => {
    for (const dialect of ["mysql", "mariadb"] as const) {
      expect(splitSQLStatements(hidden, dialect)).toEqual([
        String.raw`SELECT '\' , '`,
        "DROP TABLE t",
        "SELECT ''",
      ]);
      expect(stripCommentsAndStrings(hidden, dialect)).toContain("DROP TABLE t");
    }
    const doubleQuoted = String.raw`SELECT "\" , "; DROP TABLE t; SELECT ""`;
    expect(splitSQLStatements(doubleQuoted, "mysql")).toHaveLength(3);
  });

  it("ends a PostgreSQL E string only at an unescaped quote", () => {
    for (const prefix of ["E", "e"]) {
      const sql = String.raw`SELECT ${prefix}'\' , '; DROP TABLE t; SELECT ''`;
      expect(splitSQLStatements(sql, "postgres")).toHaveLength(3);
      expect(stripCommentsAndStrings(sql, "postgres")).toContain("DROP TABLE t");
    }
  });

  it("keeps PostgreSQL E string rules in a constant continued on the next line", () => {
    const continued = "SELECT E''\n'\\' , '; COMMIT; DROP TABLE t; SELECT ''";
    expect(splitSQLStatements(continued, "postgres")).toHaveLength(4);
    const withComment = "SELECT E'a'\n  -- note\n'\\' , '; DROP TABLE t; SELECT ''";
    expect(splitSQLStatements(withComment, "postgres")).toHaveLength(3);
    for (const gap of ["-- note\n", "\r", "\v\n", "\n\v"]) {
      expect(splitSQLStatements(`SELECT E''${gap}'\\' , '; COMMIT; DROP TABLE t; SELECT ''`, "postgres")).toHaveLength(4);
    }
    // No newline between the parts: not a continuation.
    expect(splitSQLStatements("SELECT E'a' 'b; c'", "postgres")).toHaveLength(1);
  });

  it("keeps a backslash ordinary in plain PostgreSQL, SQLite, SQL Server and ANSI strings", () => {
    for (const dialect of ["postgres", "sqlite", "sqlserver", undefined] as const) {
      expect(splitSQLStatements(hidden, dialect)).toEqual([hidden]);
    }
  });

  it("does not take an identifier ending in e as an E string prefix", () => {
    const sql = String.raw`SELECT type'\' , '; DROP TABLE t; SELECT ''`;
    expect(splitSQLStatements(sql, "postgres")).toEqual([sql]);
  });

  it("keeps blanked output the same length with escapes and a trailing backslash", () => {
    for (const sql of ["SELECT 'a\\", String.raw`SELECT 'it''s\'' ok' FROM t`]) {
      expect(blankCommentsAndStrings(sql, "mysql")).toHaveLength(sql.length);
    }
    expect(blankCommentsAndStrings(String.raw`SELECT 'a\'b' FROM t`, "mysql")).toBe(
      `SELECT${" ".repeat(8)}FROM t`
    );
  });

  it("returns every MySQL/MariaDB reading, since sql_mode is not visible in the SQL", () => {
    // Under NO_BACKSLASH_ESCAPES the string ends at the second quote and the DROP runs.
    const noBackslash = String.raw`SELECT '\'; DROP TABLE t; SELECT ''`;
    expect(splitSQLStatements(noBackslash, "mysql")).toHaveLength(1);
    expect(splitSQLStatementVariants(noBackslash, "mysql").map((v) => v.length)).toEqual([1, 3, 1]);
    // Under ANSI_QUOTES "..." is an identifier, so a backslash does not escape its quote.
    const ansiQuotes = String.raw`SELECT 1 AS "\" , '\' , '; DROP TABLE t; SELECT 1 AS "a"`;
    expect(splitSQLStatementVariants(ansiQuotes, "mariadb").map((v) => v.length)).toEqual([1, 1, 3]);
    expect(
      stripCommentsAndStringsVariants(ansiQuotes, "mariadb").some((s) => s.includes("DROP TABLE t"))
    ).toBe(true);
  });

  it("returns one reading for dialects without a mode-dependent string syntax", () => {
    expect(splitSQLStatementVariants("SELECT 1; SELECT 2", "postgres")).toEqual([
      ["SELECT 1", "SELECT 2"],
    ]);
    expect(stripCommentsAndStringsVariants("SELECT 'a'", "sqlite")).toEqual(["SELECT  "]);
  });
});

describe("ClickHouse syntax", () => {
  it.each([
    ["a -- comment", "SELECT 1 -- DROP TABLE t"],
    ["a // comment", "SELECT 1 // DROP TABLE t"],
    ["a # comment followed by a space", "SELECT 1 # DROP TABLE t"],
    ["a #! comment", "SELECT 1 #! DROP TABLE t"],
    ["a nested block comment", "SELECT 1 /* a /* DROP TABLE t */ b */"],
    ["a string with a backslash-escaped quote", String.raw`SELECT 'it\'s; DROP TABLE t'`],
    ["a quoted identifier with a backslash-escaped quote", String.raw`SELECT 1 AS "a\"; DROP TABLE t"`],
    ["a backtick identifier with a backslash-escaped backtick", "SELECT 1 AS `a\\`; DROP TABLE t`"],
    ["a heredoc", "SELECT $tag$it's; DROP TABLE t$tag$"],
  ])("hides the contents of %s", (_label, sql) => {
    expect(stripCommentsAndStrings(sql, "clickhouse")).not.toContain("DROP");
    expect(splitSQLStatements(sql, "clickhouse")).toHaveLength(1);
  });

  it("does not treat a # that is not followed by a space or ! as a comment", () => {
    expect(splitSQLStatements("SELECT 1 #x; SELECT 2", "clickhouse")).toEqual(["SELECT 1 #x", "SELECT 2"]);
  });

  it("leaves a {name:Type} placeholder and a map literal as plain text", () => {
    const sql = "SELECT {p1:String}, map('a', 1), {'k': 2}['k']";
    expect(stripCommentsAndStrings(sql, "clickhouse")).toContain("{p1:String}");
  });

  it("splits statements around comments and strings that hold semicolons", () => {
    expect(
      splitSQLStatements("SELECT 'a;b'; // one; two\nSELECT `c;d` FROM t; /* x; */ SELECT 3", "clickhouse")
    ).toEqual(["SELECT 'a;b'", "// one; two\nSELECT `c;d` FROM t", "/* x; */ SELECT 3"]);
  });
});
