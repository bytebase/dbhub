import { describe, expect, it } from "vitest";
import { classifyPostgresSQL, isPostgresSelect } from "../postgres-sql.js";
import { classifySQL, policyFromReadonly, sqlVerdict } from "../sql-access-policy.js";

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
    ["SELECT 1 UNION SELECT pg_read_file('x')", "admin"],
    ["INSERT INTO t SELECT pg_read_file('x')", "admin"],
    ["SELECT set_config, 'DELETE', $$; DROP TABLE t$$ FROM t", "read"],
    ["WITH recursive_query AS (SELECT 1) SELECT * FROM recursive_query", "read"],
    [
      "WITH RECURSIVE t(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM t WHERE n<3) SELECT * FROM t",
      "read",
    ],
    ["SELECT count(*) FILTER (WHERE active) OVER () FROM t", "read"],
    ["EXPLAIN DELETE FROM t", "read"],
    ["EXPLAIN (ANALYZE true, ANALYZE false) DELETE FROM t", "read"],
    ["EXPLAIN (ANALYZE false, ANALYZE true) DELETE FROM t", "dml"],
    ['EXPLAIN ("analyze") DELETE FROM t', "dml"],
    ["EXPLAIN (ANALYZE 'off') DELETE FROM t", "read"],
    ["EXPLAIN (RUN_IT) DELETE FROM t", "dml"],
    ["SELECT 1; GRANT SELECT ON t TO reader", "admin"],
    ["DO $$ BEGIN DELETE FROM t; END $$", "unknown"],
    ["CALL do_something()", "unknown"],
    ["SELECT * FROM `t`", "unknown"],
    ["SELECT 1; invalid syntax", "unknown"],
    ["", "unknown"],
    ["-- comment", "unknown"],
  ] as const)("%s → %s", (sql, expected) => {
    expect(classifyPostgresSQL(sql)).toBe(expected);
    expect(classifySQL(sql, "postgres")).toBe(expected);
  });

  it("denies parse failures only when the policy requires read-only", () => {
    const sql = "SELECT * FROM `t`";
    expect(sqlVerdict(policyFromReadonly(true), sql, "postgres")).toBe("deny");
    expect(sqlVerdict(policyFromReadonly(false), sql, "postgres")).toBe("allow");
  });

  it("does not limit writes or multiple statements as an ordinary SELECT", () => {
    expect(isPostgresSelect("SELECT 1 INTO backup UNION SELECT 2")).toBe(false);
    expect(isPostgresSelect("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d")).toBe(false);
    expect(isPostgresSelect("SELECT 1; SELECT 2")).toBe(false);
  });
});
