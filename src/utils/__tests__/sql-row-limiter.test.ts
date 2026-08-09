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

  describe("applyMaxRows - leading comments", () => {
    // A query introduced by a comment (an attribution tag, say) is still a
    // SELECT. Classifying on the raw text made `max_rows` silently inert for
    // every one of them.
    it("caps a query introduced by a -- line comment", () => {
      const sql = "-- dbhub agent query\nSELECT * FROM users";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "-- dbhub agent query\nSELECT * FROM users\nLIMIT 100"
      );
    });

    it("caps a query introduced by a block comment", () => {
      const sql = "/* tag: report */ SELECT * FROM users";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "/* tag: report */ SELECT * FROM users\nLIMIT 100"
      );
    });

    it("caps a query introduced by several mixed leading comments", () => {
      const sql = "-- one\n/* two */\n-- three\nSELECT * FROM users";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "-- one\n/* two */\n-- three\nSELECT * FROM users\nLIMIT 100"
      );
    });

    it("leaves the caller's comment text untouched", () => {
      // The comment is load-bearing for query attribution, so only the
      // classification sees the stripped form - the SQL sent to the server
      // keeps it verbatim.
      const sql = "/* app=dbhub; user='bob' */\nSELECT * FROM users";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toContain("/* app=dbhub; user='bob' */");
    });

    it("still leaves a non-SELECT hidden behind a comment alone", () => {
      const sql = "-- looks harmless\nUPDATE users SET active = true";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(sql);
    });
  });

  describe("applyMaxRows - CTEs", () => {
    it("caps a WITH ... SELECT query", () => {
      const sql = "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent\nLIMIT 100"
      );
    });

    it("appends its own LIMIT instead of tightening a CTE's inner LIMIT", () => {
      // The CTE's LIMIT caps only the CTE; the statement can still return far
      // more rows than that (here via the join), so it needs a cap of its own.
      const sql =
        "WITH recent AS (SELECT * FROM orders LIMIT 5) SELECT * FROM recent JOIN big ON true";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "WITH recent AS (SELECT * FROM orders LIMIT 5) SELECT * FROM recent JOIN big ON true\nLIMIT 100"
      );
    });

    it("tightens the statement's own LIMIT on a CTE query", () => {
      const sql = "WITH recent AS (SELECT * FROM orders LIMIT 5) SELECT * FROM recent LIMIT 500";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "WITH recent AS (SELECT * FROM orders LIMIT 5) SELECT * FROM recent LIMIT 100"
      );
    });

    it("wraps a CTE query whose own LIMIT is parameterized", () => {
      const sql = "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent LIMIT $1";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "SELECT * FROM (WITH recent AS (SELECT * FROM orders) SELECT * FROM recent LIMIT $1\n) AS subq LIMIT 100"
      );
    });

    it.each([
      ["DELETE", "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"],
      ["INSERT", "WITH i AS (INSERT INTO t SELECT * FROM s RETURNING *) SELECT * FROM i"],
      ["UPDATE", "WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u"],
    ])("does not cap a data-modifying CTE (%s)", (_label, sql) => {
      // A LIMIT here would cap the rows handed back while the write still runs
      // in full - a cap that isn't one.
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(sql);
    });
  });

  describe("applyMaxRows - set operations and nesting", () => {
    it("caps a parenthesised set operation", () => {
      const sql = "(SELECT id FROM a) UNION (SELECT id FROM b)";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "(SELECT id FROM a) UNION (SELECT id FROM b)\nLIMIT 100"
      );
    });

    it("keeps appending a trailing LIMIT to a bare UNION ALL, which binds to the whole set operation", () => {
      const sql = "SELECT id FROM a UNION ALL SELECT id FROM b";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "SELECT id FROM a UNION ALL SELECT id FROM b\nLIMIT 100"
      );
    });

    it("appends its own LIMIT instead of tightening a subquery's LIMIT", () => {
      const sql = "SELECT * FROM (SELECT * FROM t LIMIT 5) s";
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(
        "SELECT * FROM (SELECT * FROM t LIMIT 5) s\nLIMIT 100"
      );
    });
  });

  describe("clause detection ignores nested clauses", () => {
    it("does not report a subquery's LIMIT as the statement's own", () => {
      const sql = "SELECT * FROM (SELECT * FROM t LIMIT 5) s";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(false);
      expect(SQLRowLimiter.extractLimitValue(sql)).toBe(null);
    });

    it("does not report a CTE's parameterized LIMIT as the statement's own", () => {
      const sql = "WITH x AS (SELECT * FROM t LIMIT $1) SELECT * FROM x";
      expect(SQLRowLimiter.hasParameterizedLimit(sql)).toBe(false);
    });

    it("does not report a CTE's TOP as the statement's own", () => {
      const sql = "WITH x AS (SELECT TOP 5 id FROM t) SELECT * FROM x";
      expect(SQLRowLimiter.hasTopClause(sql)).toBe(false);
      expect(SQLRowLimiter.extractTopValue(sql)).toBe(null);
    });
  });

  describe("applyMaxRowsForSQLServer", () => {
    it("caps a query introduced by a leading comment", () => {
      const sql = "-- tag\nSELECT * FROM users";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "-- tag\nSELECT TOP 100 * FROM users"
      );
    });

    it("puts TOP on the statement's own SELECT, not on the CTE's", () => {
      const sql = "WITH x AS (SELECT id FROM t) SELECT * FROM x";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "WITH x AS (SELECT id FROM t) SELECT TOP 100 * FROM x"
      );
    });

    it("leaves a CTE's own TOP alone and caps the final SELECT", () => {
      const sql = "WITH x AS (SELECT TOP 5 id FROM t) SELECT * FROM x";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "WITH x AS (SELECT TOP 5 id FROM t) SELECT TOP 100 * FROM x"
      );
    });

    it("keeps a leading CTE outside the wrapped subquery for a set operation", () => {
      // T-SQL has no `SELECT ... FROM (WITH ...) AS subq` form, but a CTE
      // declared before the SELECT is in scope inside the derived table.
      const sql = "WITH x AS (SELECT id FROM t) SELECT id FROM x UNION ALL SELECT id FROM y";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "WITH x AS (SELECT id FROM t) SELECT TOP 100 * FROM (SELECT id FROM x UNION ALL SELECT id FROM y\n) AS subq"
      );
    });

    it("does not cap a data-modifying CTE", () => {
      const sql = "WITH d AS (DELETE FROM t OUTPUT deleted.*) SELECT * FROM d";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(sql);
    });
  });

  describe("applyMaxRowsForSQLServer - pre-existing behaviour", () => {
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
