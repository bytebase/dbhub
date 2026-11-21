import { describe, expect, it } from "vitest";
import { classifyPostgresSQL, isPostgresSelect, postgresSyntaxError } from "../postgres-sql.js";
import { policyFromReadonly, sqlVerdict } from "../sql-access-policy.js";
import { splitSQLStatements } from "../sql-parser.js";

describe("PostgreSQL AST classification", () => {
  it.each([
    ["WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", "dml"],
    ["SELECT * FROM (WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d) x", "dml"],
    ["WITH x AS (SELECT 1) UPDATE t SET a = 1", "dml"],
    ["SELECT * INTO backup FROM t", "ddl"],
    ["SELECT 1 INTO backup UNION SELECT 2", "ddl"],
    ["SELECT pg_catalog.\"set_config\"('search_path', 'public', false)", "admin"],
    [String.raw`SELECT U&"\0073et_config"('search_path', 'public', false)`, "admin"],
    ["SELECT * FROM (SELECT pg_read_file('x')) t", "admin"],
    ["SELECT pg_read_binary_file('x')", "admin"],
    ["SELECT pg_ls_dir('x')", "admin"],
    ["SELECT 1 UNION SELECT pg_read_file('x')", "admin"],
    ["INSERT INTO t SELECT pg_read_file('x')", "admin"],
    // Attribute notation: PostgreSQL calls a one-argument function written as a field.
    ["SELECT ('PG_VERSION'::text).pg_read_file", "admin"],
    ["SELECT (t.path).pg_ls_dir FROM t", "admin"],
    ["SELECT (t.c).name FROM t", "read"],
    ["SELECT set_config, 'DELETE', $$; DROP TABLE t$$ FROM t", "read"],
    ["EXPLAIN DELETE FROM t", "read"],
    ["EXPLAIN ANALYZE SELECT 1", "read"],
    ["EXPLAIN (VERBOSE, FORMAT JSON) DELETE FROM t", "read"],
    ["EXPLAIN (RUN_IT) SELECT 1", "read"],
    ["EXPLAIN (ANALYZE true, ANALYZE false) DELETE FROM t", "read"],
    ["EXPLAIN (ANALYZE false, ANALYZE true) DELETE FROM t", "dml"],
    ['EXPLAIN ("analyze") DELETE FROM t', "dml"],
    ["EXPLAIN (ANALYZE 'off') DELETE FROM t", "read"],
    ["EXPLAIN (RUN_IT) DELETE FROM t", "dml"],
    ["SELECT 1; GRANT SELECT ON t TO reader", "admin"],
    ["DO $$ BEGIN DELETE FROM t; END $$", "unknown"],
    ["SELECT 1; invalid syntax", "unknown"],
    ["", "unknown"],
    ["-- comment", "unknown"],
  ] as const)("%s → %s", (sql, expected) => {
    expect(classifyPostgresSQL(sql)).toBe(expected);
  });

  it("denies parse failures only when the policy requires read-only", () => {
    const sql = "SELECT * FROM `t`";
    expect(sqlVerdict(policyFromReadonly(true), sql, "postgres")).toBe("deny");
    expect(sqlVerdict(policyFromReadonly(false), sql, "postgres")).toBe("allow");
  });

  // The connector sends each piece splitSQLStatements produces as its own
  // query, so a piece the whole-text parse never saw as a statement must count.
  it("classifies the statements the connector will send", () => {
    // `a$$` is an identifier: the parser and the splitter both see one SELECT and a comment.
    const commented = "SELECT 1 AS a$$ -- $$ ; COMMIT; DELETE FROM t";
    expect(splitSQLStatements(commented, "postgres")).toEqual([commented]);
    expect(classifyPostgresSQL(commented)).toBe("read");
    // One string constant to the parser, but the splitter does not read a
    // non-ASCII tag and would send COMMIT on its own.
    const split = "SELECT $\u00e9$; COMMIT; $\u00e9$";
    expect(splitSQLStatements(split, "postgres")).toContain("COMMIT");
    expect(classifyPostgresSQL(split)).toBe("unknown");
    expect(classifyPostgresSQL("SELECT 1; -- done")).toBe("read");
  });

  it("does not limit writes or multiple statements as an ordinary SELECT", () => {
    expect(isPostgresSelect("SELECT 1 INTO backup UNION SELECT 2")).toBe(false);
    expect(isPostgresSelect("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d")).toBe(false);
    expect(isPostgresSelect("SELECT 1; SELECT 2")).toBe(false);
  });

  // Whether a LIMIT applies depends on the statement's shape, not on whether a
  // read-only tool would allow it.
  it("treats a SELECT calling a restricted function as an ordinary SELECT to limit", () => {
    expect(classifyPostgresSQL("SELECT pg_ls_dir('.')")).toBe("admin");
    expect(isPostgresSelect("SELECT pg_ls_dir('.')")).toBe(true);
    expect(isPostgresSelect("SELECT *, set_config('app.x', '1', true) FROM t")).toBe(true);
    expect(isPostgresSelect("EXPLAIN ANALYZE SELECT 1")).toBe(false);
    expect(isPostgresSelect("-- comment")).toBe(false);
  });

  it("cannot tell the shape of SQL the parser does not read", () => {
    expect(isPostgresSelect("SELECT * FROM t AS OF SYSTEM TIME '-10s'")).toBeNull();
  });

  it("reports the parser's error, with PostgreSQL's 1-based position", () => {
    expect(postgresSyntaxError("SELECT * FORM t")).toBe('syntax error at or near "FORM" (position 10)');
    // Readable as a whole, but not as the pieces the connector would send.
    expect(postgresSyntaxError("SELECT $\u00e9$; COMMIT; $\u00e9$")).toMatch(/unterminated/);
    expect(postgresSyntaxError("DELETE FROM t")).toBeNull();
    expect(postgresSyntaxError("-- comment")).toBeNull();
    expect(postgresSyntaxError("")).toBeNull();
  });
});
