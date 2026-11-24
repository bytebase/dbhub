import { describe, it, expect } from "vitest";
import { SQLRowLimiter } from "../sql-row-limiter.js";

/**
 * One statement through a plain entry point and its truncation-probe twin, both
 * at a cap of 100: [what the case shows, sql, capped, probed].
 *
 * `capped` is the plain rewrite. `probed` is the SQL the probe variant sends
 * instead (the same rewrite at cap + 1 = 101), or null when the statement's own
 * cap is already within 100: the cap cannot fire then, so the probe variant
 * returns the statement exactly as written, with probeApplied: false.
 */
type CapAndProbeCase = [name: string, sql: string, capped: string, probed: string | null];

const probeResult = (sql: string, probed: string | null) =>
  probed === null ? { sql, probeApplied: false } : { sql: probed, probeApplied: true };

describe("SQLRowLimiter", () => {
  describe("LIMIT detection - edge cases with comments and strings", () => {
    // `true`: the statement has its own LIMIT 10, within the cap, so it is left
    // alone. `false`: the word only appears in a string or comment, so the
    // statement has no LIMIT and gets the cap appended.
    it.each([
      ["inside single-quoted string", "SELECT 'show limit 10 records' AS msg FROM users", false],
      ["inside double-quoted identifier", 'SELECT "limit 10" AS col FROM users', false],
      ["inside single-line comment", "SELECT * FROM users -- limit 10\nWHERE active = true", false],
      ["inside multi-line comment", "SELECT * FROM users /* limit 10 */ WHERE active = true", false],
      ["inside string with escaped quotes", "SELECT 'it''s limit 10' AS msg FROM users", false],
      ["real LIMIT after string containing 'limit'", "SELECT 'limit' AS word FROM users LIMIT 10", true],
      ["real LIMIT after comment containing 'limit'", "SELECT * FROM users /* show limit */ LIMIT 10", true],
    ])("LIMIT %s -> %s", (_label, sql, hasOwnLimit) => {
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(hasOwnLimit ? sql : `${sql}\nLIMIT 100`);
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

  describe("applyMaxRows and applyMaxRowsWithTruncationProbe", () => {
    it.each<CapAndProbeCase>([
      ["adds a LIMIT when none exists", "SELECT * FROM users", "SELECT * FROM users\nLIMIT 100", "SELECT * FROM users\nLIMIT 101"],
      ["keeps a LIMIT below the cap", "SELECT * FROM users LIMIT 50", "SELECT * FROM users LIMIT 50", null],
      // The user asked for exactly maxRows rows — that's their limit firing,
      // not the cap, so no probe and never a truncated flag.
      ["keeps a LIMIT equal to the cap", "SELECT * FROM users LIMIT 100", "SELECT * FROM users LIMIT 100", null],
      ["tightens a LIMIT above the cap", "SELECT * FROM users LIMIT 200", "SELECT * FROM users LIMIT 100", "SELECT * FROM users LIMIT 101"],
      [
        "wraps a parameterized LIMIT in a subquery",
        "SELECT * FROM users LIMIT $1",
        "SELECT * FROM (SELECT * FROM users LIMIT $1\n) AS subq LIMIT 100",
        "SELECT * FROM (SELECT * FROM users LIMIT $1\n) AS subq LIMIT 101",
      ],
      // A nested LIMIT caps only its own query; the statement can still return
      // far more rows than that (here via the join), so it needs a cap of its
      // own, and the inner LIMIT must not be mistaken for a user cap already
      // within maxRows.
      [
        "appends its own LIMIT instead of tightening a CTE's inner LIMIT",
        "WITH recent AS (SELECT * FROM orders LIMIT 5) SELECT * FROM recent JOIN big ON true",
        "WITH recent AS (SELECT * FROM orders LIMIT 5) SELECT * FROM recent JOIN big ON true\nLIMIT 100",
        "WITH recent AS (SELECT * FROM orders LIMIT 5) SELECT * FROM recent JOIN big ON true\nLIMIT 101",
      ],
      [
        "appends its own LIMIT instead of tightening a subquery's LIMIT",
        "SELECT * FROM (SELECT * FROM t LIMIT 5) s",
        "SELECT * FROM (SELECT * FROM t LIMIT 5) s\nLIMIT 100",
        "SELECT * FROM (SELECT * FROM t LIMIT 5) s\nLIMIT 101",
      ],
      [
        "appends its own LIMIT instead of wrapping for a CTE's parameterized LIMIT",
        "WITH x AS (SELECT * FROM t LIMIT $1) SELECT * FROM x",
        "WITH x AS (SELECT * FROM t LIMIT $1) SELECT * FROM x\nLIMIT 100",
        "WITH x AS (SELECT * FROM t LIMIT $1) SELECT * FROM x\nLIMIT 101",
      ],
    ])("%s", (_name, sql, capped, probed) => {
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(capped);
      expect(SQLRowLimiter.applyMaxRowsWithTruncationProbe(sql, 100)).toEqual(probeResult(sql, probed));
    });

    // MySQL, MariaDB and SQLite accept `LIMIT offset, count`: the first number
    // is the offset, so the cap applies to the second and the offset is kept
    // exactly as written.
    it.each<CapAndProbeCase>([
      [
        "tightens the count, not the offset",
        "SELECT * FROM users LIMIT 500, 200",
        "SELECT * FROM users LIMIT 500, 100",
        "SELECT * FROM users LIMIT 500, 101",
      ],
      [
        "tightens a count above the cap behind an offset below it",
        "SELECT * FROM users LIMIT 5, 200",
        "SELECT * FROM users LIMIT 5, 100",
        "SELECT * FROM users LIMIT 5, 101",
      ],
      ["keeps a count below the cap behind an offset above it", "SELECT * FROM users LIMIT 500, 50", "SELECT * FROM users LIMIT 500, 50", null],
      ["keeps a count equal to the cap", "SELECT * FROM users LIMIT 500, 100", "SELECT * FROM users LIMIT 500, 100", null],
      [
        "tightens the count without spaces around the comma",
        "SELECT * FROM users LIMIT 500,200;",
        "SELECT * FROM users LIMIT 500,100;",
        "SELECT * FROM users LIMIT 500,101;",
      ],
      [
        "tightens the count behind a parameterized offset",
        "SELECT * FROM users LIMIT ?, 200",
        "SELECT * FROM users LIMIT ?, 100",
        "SELECT * FROM users LIMIT ?, 101",
      ],
      [
        "wraps a parameterized count",
        "SELECT * FROM users LIMIT 500, ?",
        "SELECT * FROM (SELECT * FROM users LIMIT 500, ?\n) AS subq LIMIT 100",
        "SELECT * FROM (SELECT * FROM users LIMIT 500, ?\n) AS subq LIMIT 101",
      ],
      // SQLite named parameter: not a literal, so the count is unknown
      [
        "wraps a count that is not a literal number",
        "SELECT * FROM users LIMIT 5, :count",
        "SELECT * FROM (SELECT * FROM users LIMIT 5, :count\n) AS subq LIMIT 100",
        "SELECT * FROM (SELECT * FROM users LIMIT 5, :count\n) AS subq LIMIT 101",
      ],
      // SQLite: a negative count means no upper bound, and OFFSET is only legal after a LIMIT
      [
        "wraps LIMIT -1 OFFSET n instead of appending a second LIMIT",
        "SELECT * FROM users ORDER BY id LIMIT -1 OFFSET 5",
        "SELECT * FROM (SELECT * FROM users ORDER BY id LIMIT -1 OFFSET 5\n) AS subq LIMIT 100",
        "SELECT * FROM (SELECT * FROM users ORDER BY id LIMIT -1 OFFSET 5\n) AS subq LIMIT 101",
      ],
      [
        "wraps a negative count behind an offset",
        "SELECT * FROM users LIMIT 5, -1;",
        "SELECT * FROM (SELECT * FROM users LIMIT 5, -1\n) AS subq LIMIT 100;",
        "SELECT * FROM (SELECT * FROM users LIMIT 5, -1\n) AS subq LIMIT 101;",
      ],
      [
        "tightens LIMIT count OFFSET offset, leaving the offset alone",
        "SELECT * FROM users LIMIT 200 OFFSET 500",
        "SELECT * FROM users LIMIT 100 OFFSET 500",
        "SELECT * FROM users LIMIT 101 OFFSET 500",
      ],
    ])("LIMIT offset, count: %s", (_name, sql, capped, probed) => {
      expect(SQLRowLimiter.applyMaxRows(sql, 100)).toBe(capped);
      expect(SQLRowLimiter.applyMaxRowsWithTruncationProbe(sql, 100)).toEqual(probeResult(sql, probed));
    });
  });

  describe("applyMaxRows", () => {
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

  describe("applyMaxRows - set operations", () => {
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
  });

  describe("dialect-aware scanning", () => {
    it("caps a PostgreSQL SELECT whatever it calls, and one the parser cannot read", () => {
      // A restricted function changes what a read-only tool allows, not whether rows come back.
      const restricted = "SELECT pg_ls_dir('.')";
      expect(SQLRowLimiter.applyMaxRowsWithTruncationProbe(restricted, 10, "postgres")).toEqual({
        sql: `${restricted}\nLIMIT 11`,
        probeApplied: true,
      });
      // Another engine's syntax behind a postgres:// DSN: the keyword heuristic still applies.
      const foreign = "SELECT * FROM t AS OF SYSTEM TIME '-10s'";
      expect(SQLRowLimiter.applyMaxRows(foreign, 10, "postgres")).toBe(`${foreign}\nLIMIT 10`);
      const foreignWrite = "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d AS OF SYSTEM TIME '-10s'";
      expect(SQLRowLimiter.applyMaxRows(foreignWrite, 10, "postgres")).toBe(foreignWrite);
    });

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
    it("wraps a SELECT in an inline view capped with FETCH FIRST, probing with one extra row", () => {
      expect(SQLRowLimiter.applyMaxRowsForOracle("SELECT * FROM users", 100)).toBe(
        "SELECT * FROM (SELECT * FROM users\n) FETCH FIRST 100 ROWS ONLY"
      );
      // The cap always wraps, so the probe applies to every row-returning statement.
      expect(
        SQLRowLimiter.applyMaxRowsForOracleWithTruncationProbe("SELECT * FROM users", 100)
      ).toEqual({
        sql: "SELECT * FROM (SELECT * FROM users\n) FETCH FIRST 101 ROWS ONLY",
        probeApplied: true,
      });
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
  });

  describe("applyMaxRowsForSQLServer and applyMaxRowsForSQLServerWithTruncationProbe", () => {
    it.each<CapAndProbeCase>([
      ["adds TOP when none exists", "SELECT * FROM users", "SELECT TOP 100 * FROM users", "SELECT TOP 101 * FROM users"],
      ["keeps a TOP within the cap", "SELECT TOP 50 * FROM users", "SELECT TOP 50 * FROM users", null],
      ["tightens a TOP above the cap", "SELECT TOP 200 * FROM users", "SELECT TOP 100 * FROM users", "SELECT TOP 101 * FROM users"],
      // A parenthesised literal is the statement's own TOP (issue #453): it is
      // tightened to min(3, 100) = 3, i.e. the user's own cap, not given a second TOP.
      ["recognises TOP (3)", "SELECT TOP (3) name FROM users ORDER BY name", "SELECT TOP 3 name FROM users ORDER BY name", null],
      ["recognises TOP(3)", "SELECT TOP(3) name FROM users ORDER BY name", "SELECT TOP 3 name FROM users ORDER BY name", null],
      ["recognises TOP ( 3 )", "SELECT TOP ( 3 ) name FROM users ORDER BY name", "SELECT TOP 3 name FROM users ORDER BY name", null],
      // T-SQL requires `SELECT DISTINCT TOP n`; `SELECT TOP n DISTINCT` is a syntax error.
      ["inserts TOP after SELECT DISTINCT", "SELECT DISTINCT status FROM orders", "SELECT DISTINCT TOP 100 status FROM orders", "SELECT DISTINCT TOP 101 status FROM orders"],
      ["inserts TOP after SELECT ALL", "SELECT ALL status FROM orders", "SELECT ALL TOP 100 status FROM orders", "SELECT ALL TOP 101 status FROM orders"],
      [
        "leaves a CTE's own TOP alone and caps the final SELECT",
        "WITH x AS (SELECT TOP 5 id FROM t) SELECT * FROM x",
        "WITH x AS (SELECT TOP 5 id FROM t) SELECT TOP 100 * FROM x",
        "WITH x AS (SELECT TOP 5 id FROM t) SELECT TOP 101 * FROM x",
      ],
      // TOP 1 WITH TIES / TOP 1 PERCENT can return thousands of rows, and a
      // parameter is not known until runtime, so a literal within the cap must
      // not be taken as the user's own limit: the statement is always wrapped
      // and probed.
      [
        "wraps a TOP n WITH TIES, which is not a row bound",
        "SELECT TOP 1 WITH TIES id FROM orders ORDER BY discount",
        "SELECT TOP 100 * FROM (SELECT TOP 1 WITH TIES id FROM orders ORDER BY discount\n) AS subq",
        "SELECT TOP 101 * FROM (SELECT TOP 1 WITH TIES id FROM orders ORDER BY discount\n) AS subq",
      ],
      [
        "wraps a TOP n PERCENT, which is not a row bound",
        "SELECT TOP 1 PERCENT id FROM orders",
        "SELECT TOP 100 * FROM (SELECT TOP 1 PERCENT id FROM orders\n) AS subq",
        "SELECT TOP 101 * FROM (SELECT TOP 1 PERCENT id FROM orders\n) AS subq",
      ],
      [
        "wraps a TOP (@p1), which is not a row bound",
        "SELECT TOP (@p1) id FROM orders",
        "SELECT TOP 100 * FROM (SELECT TOP (@p1) id FROM orders\n) AS subq",
        "SELECT TOP 101 * FROM (SELECT TOP (@p1) id FROM orders\n) AS subq",
      ],
      [
        "recognises PERCENT with no whitespace after a parenthesised operand",
        "SELECT TOP(1)PERCENT x FROM t",
        "SELECT TOP 100 * FROM (SELECT TOP(1)PERCENT x FROM t\n) AS subq",
        "SELECT TOP 101 * FROM (SELECT TOP(1)PERCENT x FROM t\n) AS subq",
      ],
      [
        "recognises WITH TIES with no whitespace after a parenthesised operand",
        "SELECT TOP(1)WITH TIES x FROM t ORDER BY x",
        "SELECT TOP 100 * FROM (SELECT TOP(1)WITH TIES x FROM t ORDER BY x\n) AS subq",
        "SELECT TOP 101 * FROM (SELECT TOP(1)WITH TIES x FROM t ORDER BY x\n) AS subq",
      ],
      // T-SQL: "A TOP can not be used in the same query or sub-query as a OFFSET."
      [
        "caps an OFFSET ... FETCH query through its FETCH count, never with TOP",
        "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 3000 ROWS ONLY",
        "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY",
        "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 101 ROWS ONLY",
      ],
      [
        "leaves an OFFSET ... FETCH FIRST query alone when its FETCH count is within the cap",
        "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH FIRST 3 ROWS ONLY",
        "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH FIRST 3 ROWS ONLY",
        null,
      ],
      [
        "leaves an OFFSET ... FETCH NEXT query alone when its FETCH count is within the cap",
        "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY",
        "SELECT name FROM users ORDER BY name OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY",
        null,
      ],
      // The OFFSET applies to the combined output, and hoisting it next to
      // an outer TOP would be rejected (TOP and OFFSET on the same query).
      [
        "caps a set-operator query with OFFSET ... FETCH through its FETCH count",
        "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id OFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY",
        "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY",
        "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id OFFSET 0 ROWS FETCH NEXT 101 ROWS ONLY",
      ],
      [
        "leaves a set-operator query alone when its FETCH count is within the cap",
        "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY",
        "SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY",
        null,
      ],
      // A branch-level TOP caps only that branch, so the whole statement is
      // wrapped and the probe applies to the combined output.
      [
        "wraps and probes a set-operator query even when a branch has its own TOP within the cap",
        "SELECT TOP 2 id FROM a UNION ALL SELECT id FROM b",
        "SELECT TOP 100 * FROM (SELECT TOP 2 id FROM a UNION ALL SELECT id FROM b\n) AS subq",
        "SELECT TOP 101 * FROM (SELECT TOP 2 id FROM a UNION ALL SELECT id FROM b\n) AS subq",
      ],
    ])("%s", (_name, sql, capped, probed) => {
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(capped);
      expect(SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(sql, 100)).toEqual(
        probeResult(sql, probed)
      );
    });
  });

  describe("applyMaxRowsForSQLServer - comments and CTEs", () => {
    it("caps a query introduced by a leading comment", () => {
      const sql = "-- tag\nSELECT * FROM users";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        "-- tag\nSELECT TOP 100 * FROM users"
      );
    });

    it("caps a CTE introduced by the T-SQL `;WITH` convention, on the statement's own SELECT", () => {
      const sql = ";WITH x AS (SELECT id FROM t) SELECT * FROM x";
      expect(SQLRowLimiter.applyMaxRowsForSQLServer(sql, 100)).toBe(
        ";WITH x AS (SELECT id FROM t) SELECT TOP 100 * FROM x"
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

  describe("applyMaxRowsForSQLServer - set operations", () => {
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
