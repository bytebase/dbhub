import { describe, it, expect } from "vitest";
import { SQLRowLimiter } from "../sql-row-limiter.js";

describe("SQLRowLimiter", () => {
  describe("hasLimitClause - edge cases with comments and strings", () => {
    it.each([
      ["inside single-quoted string", "SELECT 'show limit 10 records' AS msg FROM users", false],
      ["inside double-quoted identifier", 'SELECT "limit 10" AS col FROM users', false],
      ["inside single-line comment", "SELECT * FROM users -- limit 10\nWHERE active = true", false],
      ["inside multi-line comment", "SELECT * FROM users /* limit 10 */ WHERE active = true", false],
      ["inside string with escaped quotes", "SELECT 'it''s limit 10' AS msg FROM users", false],
      ["real LIMIT after string containing 'limit'", "SELECT 'limit' AS word FROM users LIMIT 10", true],
      ["real LIMIT after comment containing 'limit'", "SELECT * FROM users /* show limit */ LIMIT 10", true],
    ])("LIMIT %s -> %s", (_label, sql, expected) => {
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(expected);
    });
  });

  describe("hasLimitClause", () => {
    it("should detect LIMIT with literal number", () => {
      const sql = "SELECT * FROM users LIMIT 10";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(true);
    });

    // Note: @p style parameters with LIMIT is not valid SQL Server syntax
    // (SQL Server uses TOP, not LIMIT). That case tests the regex pattern only.
    it.each([
      ["PostgreSQL parameter ($1, $2, etc.)", "SELECT * FROM users WHERE name = $1 LIMIT $2"],
      ["MySQL/SQLite parameter (?)", "SELECT * FROM users WHERE name = ? LIMIT ?"],
      ["named parameter (@p1, @p2, etc.)", "SELECT * FROM users WHERE name = @p1 LIMIT @p2"],
    ])("should detect LIMIT with %s", (_label, sql) => {
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(true);
    });

    it("should return false when no LIMIT clause exists", () => {
      const sql = "SELECT * FROM users WHERE active = true";
      expect(SQLRowLimiter.hasLimitClause(sql)).toBe(false);
    });
  });

  describe("first guard shared by every entry point", () => {
    // Every apply* entry point starts with the same `!maxRows || !isSelectQuery`
    // guard; the probe variants report it as probeApplied: false.
    const unchanged = (sql: string) => sql;
    const unprobed = (sql: string) => ({ sql, probeApplied: false });
    const entryPoints: [
      string,
      (sql: string, maxRows: number | undefined) => unknown,
      (sql: string) => unknown,
    ][] = [
      ["applyMaxRows", (sql, maxRows) => SQLRowLimiter.applyMaxRows(sql, maxRows), unchanged],
      ["applyMaxRowsForSQLServer", (sql, maxRows) => SQLRowLimiter.applyMaxRowsForSQLServer(sql, maxRows), unchanged],
      ["applyMaxRowsForOracle", (sql, maxRows) => SQLRowLimiter.applyMaxRowsForOracle(sql, maxRows), unchanged],
      ["applyMaxRowsWithTruncationProbe", (sql, maxRows) => SQLRowLimiter.applyMaxRowsWithTruncationProbe(sql, maxRows), unprobed],
      ["applyMaxRowsForSQLServerWithTruncationProbe", (sql, maxRows) => SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(sql, maxRows), unprobed],
      ["applyMaxRowsForOracleWithTruncationProbe", (sql, maxRows) => SQLRowLimiter.applyMaxRowsForOracleWithTruncationProbe(sql, maxRows), unprobed],
    ];

    it.each(entryPoints)("%s should not modify SQL when maxRows is undefined", (_name, apply, expected) => {
      const sql = "SELECT * FROM users";
      expect(apply(sql, undefined)).toEqual(expected(sql));
    });

    it.each(entryPoints)("%s should not modify non-SELECT queries", (_name, apply, expected) => {
      const sql = "UPDATE users SET active = true";
      expect(apply(sql, 100)).toEqual(expected(sql));
    });
  });

  describe("applyMaxRows", () => {
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

    it("should preserve semicolon at end when adding LIMIT", () => {
      const sql = "SELECT * FROM users;";
      const result = SQLRowLimiter.applyMaxRows(sql, 100);
      expect(result).toBe("SELECT * FROM users\nLIMIT 100;");
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
    // SELECT. Classifying on the raw text made max_rows silently inert for
    // every one of them. The comment text itself is load-bearing for query
    // attribution, so the SQL sent to the server keeps it verbatim.
    it.each([
      ["a -- line comment", "-- dbhub agent query\nSELECT * FROM users"],
      ["a block comment", "/* tag: report */ SELECT * FROM users"],
      ["several mixed leading comments", "-- one\n/* two */\n-- three\nSELECT * FROM users"],
    ])("caps a query introduced by %s, leaving the comment untouched", (_label, sql) => {
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(`${sql}\nLIMIT 100`);
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
      // in full: a cap that isn't one.
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

  describe("dialect-aware scanning", () => {
    it("does not mistake a PostgreSQL dollar-quoted literal for a data-modifying CTE", () => {
      const sql = "WITH x AS (SELECT $$DELETE FROM t$$ AS s) SELECT * FROM x";
      expect(SQLRowLimiter.applyMaxRows(sql, 100, "postgres")).toBe(`${sql}\nLIMIT 100`);
      // Without the dialect only ANSI quoting is known, so the statement is
      // left alone (uncapped, the fail-safe direction).
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(sql);
    });

    it("does not let a parenthesis inside a MySQL backtick identifier hide the statement's LIMIT", () => {
      const sql = "SELECT * FROM `a(` LIMIT 500";
      expect(SQLRowLimiter.applyMaxRows(sql, 100, "mysql")).toBe("SELECT * FROM `a(` LIMIT 100");
    });

    it("does not mistake a SQL Server bracket identifier for a data-modifying CTE", () => {
      const sql = "WITH x AS (SELECT [delete] FROM t) SELECT * FROM x";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "WITH x AS (SELECT [delete] FROM t) SELECT TOP 100 * FROM x"
      );
    });

    it("recognizes REPLACE INTO as a write inside a MySQL CTE", () => {
      const sql = "WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x";
      expect(SQLRowLimiter.applyMaxRows(sql, 100, "mysql")).toBe(sql);
    });
  });

  describe("applyMaxRowsForOracle", () => {
    it("wraps a SELECT in an inline view capped with FETCH FIRST", () => {
      expect(SQLRowLimiter.applyMaxRowsForOracle("SELECT * FROM users", 100)).toBe(
        "SELECT * FROM (SELECT * FROM users\n) FETCH FIRST 100 ROWS ONLY"
      );
    });

    it("drops the trailing semicolon, which Oracle rejects on a plain statement", () => {
      expect(SQLRowLimiter.applyMaxRowsForOracle("SELECT * FROM users;", 10)).toBe(
        "SELECT * FROM (SELECT * FROM users\n) FETCH FIRST 10 ROWS ONLY"
      );
    });

    it("caps a set operation as a whole, keeping ORDER BY inside the view", () => {
      const sql = "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id";
      expect(SQLRowLimiter.applyMaxRowsForOracle(sql, 5)).toBe(
        `SELECT * FROM (${sql}\n) FETCH FIRST 5 ROWS ONLY`
      );
    });

    it("does not mistake a q-quoted literal for a data-modifying CTE", () => {
      const sql = "WITH x AS (SELECT q'[DELETE FROM t]' AS s FROM dual) SELECT * FROM x";
      expect(SQLRowLimiter.applyMaxRowsForOracle(sql, 100)).toBe(
        `SELECT * FROM (${sql}\n) FETCH FIRST 100 ROWS ONLY`
      );
    });

    it("leaves a FOR UPDATE locking read uncapped", () => {
      const sql = "SELECT * FROM users WHERE id = 1 FOR UPDATE";
      expect(SQLRowLimiter.applyMaxRowsForOracle(sql, 10)).toBe(sql);
      expect(SQLRowLimiter.applyMaxRowsForOracleWithTruncationProbe(sql, 10)).toEqual({
        sql,
        probeApplied: false,
      });
      // ... but not one that only mentions it inside a string or subquery.
      expect(SQLRowLimiter.applyMaxRowsForOracle("SELECT 'for update' AS s FROM dual", 10)).toContain("FETCH FIRST 10");
    });

    it("applies the truncation probe to every row-returning statement", () => {
      expect(
        SQLRowLimiter.applyMaxRowsForOracleWithTruncationProbe("SELECT * FROM users", 100)
      ).toEqual({
        sql: "SELECT * FROM (SELECT * FROM users\n) FETCH FIRST 101 ROWS ONLY",
        probeApplied: true,
      });
    });
  });

  describe("applyMaxRowsForSQLServer - comments and CTEs", () => {
    it("caps a query introduced by a leading comment", () => {
      const sql = "-- tag\nSELECT * FROM users";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "-- tag\nSELECT TOP 100 * FROM users"
      );
    });

    it("caps a CTE introduced by the T-SQL `;WITH` convention", () => {
      const sql = ";WITH x AS (SELECT id FROM t) SELECT * FROM x";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        ";WITH x AS (SELECT id FROM t) SELECT TOP 100 * FROM x"
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

  describe("truncation probe - CTEs", () => {
    it("probes a CTE query, ignoring the CTE's inner LIMIT", () => {
      // The inner LIMIT 5 is not the statement's own, so it must not be
      // mistaken for a user cap already within maxRows.
      const sql = "WITH x AS (SELECT * FROM t LIMIT 5) SELECT * FROM x JOIN y ON true";
      expect(SQLRowLimiter.applyMaxRowsWithTruncationProbe(sql, 100)).toEqual({
        sql: `${sql}\nLIMIT 101`,
        probeApplied: true,
      });
    });

    it("probes a CTE query on SQL Server, ignoring the CTE's inner TOP", () => {
      const sql = "WITH x AS (SELECT TOP 5 id FROM t) SELECT * FROM x";
      expect(SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(sql, 100)).toEqual({
        sql: "WITH x AS (SELECT TOP 5 id FROM t) SELECT TOP 101 * FROM x",
        probeApplied: true,
      });
    });
  });

  describe("applyMaxRowsForSQLServer", () => {
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

    it.each(["INTERSECT", "EXCEPT"])(
      "should wrap %s queries so TOP caps the combined result set",
      (operator) => {
        const sql = `SELECT id FROM a ${operator} SELECT id FROM b`;
        const result = SQLRowLimiter.applyMaxRowsForSQLServer(sql, 5);
        expect(result).toBe(`SELECT TOP 5 * FROM (SELECT id FROM a ${operator} SELECT id FROM b\n) AS subq`);
      }
    );

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

  describe("applyMaxRowsForSQLServer - DISTINCT, TOP (n), OFFSET, PERCENT, WITH TIES (issue #453)", () => {
    it.each(["DISTINCT", "ALL"])("should insert TOP after SELECT %s", (modifier) => {
      // T-SQL requires `SELECT DISTINCT TOP n`; `SELECT TOP n DISTINCT` is a syntax error.
      const result = SQLRowLimiter.applyMaxRowsForSQLServer(`SELECT ${modifier} status FROM orders`, 100);
      expect(result).toBe(`SELECT ${modifier} TOP 100 status FROM orders`);
    });

    it("should insert TOP after the final SELECT DISTINCT of a CTE", () => {
      const sql = "WITH q AS (SELECT DISTINCT a FROM t) SELECT DISTINCT * FROM q";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "WITH q AS (SELECT DISTINCT a FROM t) SELECT DISTINCT TOP 100 * FROM q"
      );
    });

    it("should not mistake a column starting with 'all' for the ALL modifier", () => {
      expect(SQLRowLimiter.applyMaxRowsForSQLServer("SELECT all_users FROM t", 100)).toBe(
        "SELECT TOP 100 all_users FROM t"
      );
    });

    it.each(["TOP (3)", "TOP(3)", "TOP ( 3 )"])("should recognise a parenthesised %s as the statement's own TOP", (top) => {
      const sql = `SELECT ${top} name FROM users ORDER BY name`;
      expect(SQLRowLimiter.extractTopValue(sql)).toBe(3);
      // Tightened to min(3, 100) = 3, i.e. the user's own cap, not a second TOP.
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe("SELECT TOP 3 name FROM users ORDER BY name");
    });

    it("should tighten a parenthesised TOP that exceeds the cap", () => {
      expect(SQLRowLimiter.applyMaxRowsForSQLServer("SELECT TOP (3000) name FROM users", 100)).toBe(
        "SELECT TOP 100 name FROM users"
      );
    });

    it("should tighten a TOP that follows DISTINCT without disturbing DISTINCT", () => {
      expect(SQLRowLimiter.applyMaxRowsForSQLServer("SELECT DISTINCT TOP 3000 name FROM users", 100)).toBe(
        "SELECT DISTINCT TOP 100 name FROM users"
      );
    });

    it("should cap an OFFSET ... FETCH query through its FETCH count, never with TOP", () => {
      // T-SQL: "A TOP can not be used in the same query or sub-query as a OFFSET."
      const sql = "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 3000 ROWS ONLY";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY"
      );
    });

    it("should leave an OFFSET ... FETCH query alone when its FETCH count is within the cap", () => {
      const sql = "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH FIRST 3 ROWS ONLY";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(sql);
    });

    it("should append a FETCH to an OFFSET query that has none", () => {
      expect(
        SQLRowLimiter.applyMaxRowsForSQLServer("SELECT name FROM users ORDER BY name OFFSET 10 ROWS;", 100)
      ).toBe("SELECT name FROM users ORDER BY name OFFSET 10 ROWS FETCH NEXT 100 ROWS ONLY;");
    });

    it("should wrap an OFFSET query whose FETCH count is a parameter, keeping ORDER BY inside", () => {
      // The derived table's own OFFSET makes an inner ORDER BY legal, and the
      // ORDER BY has to stay inside because OFFSET/FETCH is defined by it.
      const sql = "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT @p1 ROWS ONLY";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        `SELECT TOP 100 * FROM (${sql}\n) AS subq`
      );
    });

    it("should wrap an OFFSET query with an expression offset", () => {
      const sql = "SELECT name FROM users ORDER BY name OFFSET @p1 * 2 ROWS";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        `SELECT TOP 100 * FROM (${sql}\n) AS subq`
      );
    });

    it("should not treat an OFFSET inside a subquery as the statement's own", () => {
      const sql = "SELECT * FROM (SELECT name FROM users ORDER BY name OFFSET 5 ROWS) AS t";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "SELECT TOP 100 * FROM (SELECT name FROM users ORDER BY name OFFSET 5 ROWS) AS t"
      );
    });

    it("should wrap a TOP n WITH TIES query, keeping its ORDER BY inside", () => {
      // WITH TIES can return far more than n rows, so n is not a bound.
      const sql = "SELECT TOP 1 WITH TIES id FROM orders ORDER BY discount";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        `SELECT TOP 100 * FROM (${sql}\n) AS subq`
      );
    });

    it("should wrap a TOP n PERCENT query", () => {
      const sql = "SELECT TOP 1 PERCENT id FROM orders";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        `SELECT TOP 100 * FROM (${sql}\n) AS subq`
      );
    });

    it("should wrap a TOP whose count is a parameter or expression", () => {
      const sql = "SELECT TOP (@p1) id FROM orders ORDER BY id;";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "SELECT TOP 100 * FROM (SELECT TOP (@p1) id FROM orders ORDER BY id\n) AS subq;"
      );
    });

    it("should keep a leading CTE outside the wrap of a PERCENT query", () => {
      const sql = "WITH q AS (SELECT id FROM orders) SELECT TOP 10 PERCENT id FROM q";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "WITH q AS (SELECT id FROM orders) SELECT TOP 100 * FROM (SELECT TOP 10 PERCENT id FROM q\n) AS subq"
      );
    });

    it("should recognise a TOP expression with nested parentheses as the statement's own TOP", () => {
      const sql = "SELECT TOP (COALESCE(NULLIF(@p, 0), 10)) x FROM t";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        `SELECT TOP 100 * FROM (${sql}\n) AS subq`
      );
    });

    it("should wrap rather than append when the FETCH count is in an unparsed form", () => {
      const sql = "SELECT x FROM t ORDER BY x OFFSET 0 ROWS FETCH NEXT (@p1) ROWS ONLY";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        `SELECT TOP 100 * FROM (${sql}\n) AS subq`
      );
    });

    it("should cap a set-operator query with OFFSET ... FETCH through its FETCH count", () => {
      // The OFFSET applies to the combined output, and hoisting it next to
      // an outer TOP would be rejected (TOP and OFFSET on the same query).
      const sql = "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id OFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY"
      );
      expect(
        SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(
          "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY",
          100
        ).probeApplied
      ).toBe(false);
    });

    it.each(["SELECT TOP(1)PERCENT x FROM t", "SELECT TOP(1)WITH TIES x FROM t ORDER BY x"])(
      "should recognise a modifier with no whitespace after a parenthesised operand: %s",
      (sql) => {
        expect(SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(sql, 100)).toEqual({
          sql: `SELECT TOP 101 * FROM (${sql}\n) AS subq`,
          probeApplied: true,
        });
      }
    );

    it("should keep a statement-level OPTION hint outside the wrap", () => {
      // OPTION is only allowed on the outermost statement.
      expect(
        SQLRowLimiter.applyMaxRowsForSQLServer("SELECT TOP (@p1) x FROM t ORDER BY x OPTION (RECOMPILE);", 100)
      ).toBe("SELECT TOP 100 * FROM (SELECT TOP (@p1) x FROM t ORDER BY x\n) AS subq OPTION (RECOMPILE);");
      expect(
        SQLRowLimiter.applyMaxRowsForSQLServer("SELECT id FROM a UNION ALL SELECT id FROM b OPTION (MAXDOP 1)", 100)
      ).toBe("SELECT TOP 100 * FROM (SELECT id FROM a UNION ALL SELECT id FROM b\n) AS subq OPTION (MAXDOP 1)");
      expect(
        SQLRowLimiter.applyMaxRowsForSQLServer("SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id OPTION (MAXDOP 1)", 100)
      ).toBe("SELECT TOP 100 * FROM (SELECT id FROM a UNION ALL SELECT id FROM b\n) AS subq ORDER BY id OPTION (MAXDOP 1)");
    });

    it("should not treat 'top (3)' inside a string literal as a TOP clause", () => {
      expect(SQLRowLimiter.applyMaxRowsForSQLServer("SELECT 'top (3)' AS s FROM t", 100)).toBe(
        "SELECT TOP 100 'top (3)' AS s FROM t"
      );
    });
  });

  describe("applyMaxRowsWithTruncationProbe", () => {
    it("should add a probe LIMIT of maxRows + 1 when no LIMIT exists", () => {
      const result = SQLRowLimiter.applyMaxRowsWithTruncationProbe("SELECT * FROM users", 100);
      expect(result).toEqual({ sql: "SELECT * FROM users\nLIMIT 101", probeApplied: true });
    });

    it("should not probe when the query's own LIMIT is below the cap", () => {
      const sql = "SELECT * FROM users LIMIT 50";
      expect(SQLRowLimiter.applyMaxRowsWithTruncationProbe(sql, 100)).toEqual({
        sql,
        probeApplied: false,
      });
    });

    it("should not probe when the query's own LIMIT equals the cap", () => {
      // The user asked for exactly maxRows rows — that's their limit firing,
      // not the cap, so no probe and never a truncated flag.
      const sql = "SELECT * FROM users LIMIT 100";
      expect(SQLRowLimiter.applyMaxRowsWithTruncationProbe(sql, 100)).toEqual({
        sql,
        probeApplied: false,
      });
    });

    it("should probe with maxRows + 1 when the query's LIMIT exceeds the cap", () => {
      const result = SQLRowLimiter.applyMaxRowsWithTruncationProbe(
        "SELECT * FROM users LIMIT 200",
        100
      );
      expect(result).toEqual({ sql: "SELECT * FROM users LIMIT 101", probeApplied: true });
    });

    it("should probe by wrapping a parameterized LIMIT in a subquery", () => {
      const result = SQLRowLimiter.applyMaxRowsWithTruncationProbe(
        "SELECT * FROM users LIMIT $1",
        100
      );
      expect(result).toEqual({
        sql: "SELECT * FROM (SELECT * FROM users LIMIT $1\n) AS subq LIMIT 101",
        probeApplied: true,
      });
    });
  });

  describe("applyMaxRowsForSQLServerWithTruncationProbe", () => {
    it("should add a probe TOP of maxRows + 1 when no TOP exists", () => {
      const result = SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(
        "SELECT * FROM users",
        100
      );
      expect(result).toEqual({ sql: "SELECT TOP 101 * FROM users", probeApplied: true });
    });

    it("should not probe when the query's own TOP is within the cap", () => {
      const sql = "SELECT TOP 50 * FROM users";
      expect(SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(sql, 100)).toEqual({
        sql,
        probeApplied: false,
      });
    });

    it("should probe with maxRows + 1 when the query's TOP exceeds the cap", () => {
      const result = SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(
        "SELECT TOP 200 * FROM users",
        100
      );
      expect(result).toEqual({ sql: "SELECT TOP 101 * FROM users", probeApplied: true });
    });

    it("should probe a set-operator query even when a branch has its own TOP", () => {
      // A branch-level TOP caps only that branch, so the whole statement is
      // wrapped and the probe applies to the combined output.
      const result = SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(
        "SELECT TOP 2 id FROM a UNION ALL SELECT id FROM b",
        5
      );
      expect(result).toEqual({
        sql: "SELECT TOP 6 * FROM (SELECT TOP 2 id FROM a UNION ALL SELECT id FROM b\n) AS subq",
        probeApplied: true,
      });
    });

    it("should not probe when the query's own parenthesised TOP is within the cap", () => {
      const sql = "SELECT TOP (3) name FROM users ORDER BY name";
      expect(SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(sql, 100)).toEqual({
        sql,
        probeApplied: false,
      });
    });

    it("should not probe when the query's own FETCH count is within the cap", () => {
      const sql = "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY";
      expect(SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(sql, 100)).toEqual({
        sql,
        probeApplied: false,
      });
    });

    it("should probe through the FETCH count when it exceeds the cap", () => {
      expect(
        SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(
          "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 3000 ROWS ONLY",
          100
        )
      ).toEqual({
        sql: "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 101 ROWS ONLY",
        probeApplied: true,
      });
    });

    it.each([
      "SELECT TOP 1 WITH TIES id FROM orders ORDER BY discount",
      "SELECT TOP 1 PERCENT id FROM orders",
      "SELECT TOP (@p1) id FROM orders",
    ])("should always probe a TOP that is not a row bound: %s", (sql) => {
      // TOP 1 WITH TIES / TOP 1 PERCENT can return thousands of rows, so a
      // literal within the cap must not be taken as the user's own limit.
      expect(SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(sql, 100)).toEqual({
        sql: `SELECT TOP 101 * FROM (${sql}\n) AS subq`,
        probeApplied: true,
      });
    });

    it("should probe a SELECT DISTINCT by inserting TOP after DISTINCT", () => {
      expect(
        SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe("SELECT DISTINCT status FROM orders", 100)
      ).toEqual({ sql: "SELECT DISTINCT TOP 101 status FROM orders", probeApplied: true });
    });
  });

  describe("flagTruncation", () => {
    it("should drop the probe row, clamp the count, and set truncated", () => {
      const resultSet = {
        sql: "SELECT * FROM users",
        rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
        rowCount: 3,
      };
      SQLRowLimiter.flagTruncation(resultSet, 2, true);
      expect(resultSet).toEqual({
        sql: "SELECT * FROM users",
        rows: [{ id: 1 }, { id: 2 }],
        rowCount: 2,
        truncated: true,
      });
    });

    it("should leave a complete result untouched (no truncated key)", () => {
      const resultSet = { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
      SQLRowLimiter.flagTruncation(resultSet, 2, true);
      expect(resultSet).toEqual({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
      expect("truncated" in resultSet).toBe(false);
    });

    it.each([
      ["the probe was not applied", 2, false],
      ["maxRows is undefined", undefined, true],
    ])("should do nothing when %s", (_label, maxRows, probeApplied) => {
      const resultSet = { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], rowCount: 3 };
      SQLRowLimiter.flagTruncation(resultSet, maxRows, probeApplied);
      expect(resultSet).toEqual({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], rowCount: 3 });
    });
  });
});
