import { describe, it, expect } from "vitest";
import { isReadOnlySQL } from "../allowed-keywords.js";

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

    it("should identify INSERT as not read-only", () => {
      expect(isReadOnlySQL("INSERT INTO users VALUES (1)", "postgres")).toBe(false);
    });

    it("should identify UPDATE as not read-only", () => {
      expect(isReadOnlySQL("UPDATE users SET name = 'test'", "postgres")).toBe(false);
    });

    it("should identify DELETE as not read-only", () => {
      expect(isReadOnlySQL("DELETE FROM users", "postgres")).toBe(false);
    });
  });

  describe("comment handling", () => {
    it("should detect read-only after stripping single-line comment", () => {
      const sql = "-- this is a comment\nSELECT * FROM users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

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

    it("should allow REPLACE() as a function in MySQL SELECT", () => {
      expect(isReadOnlySQL("SELECT REPLACE(name, 'a', 'b') FROM users", "mysql")).toBe(true);
    });

    it("should allow REPLACE() inside a WITH CTE in MySQL", () => {
      const sql = "WITH cte AS (SELECT REPLACE(name, 'a', 'b') AS cleaned FROM users) SELECT * FROM cte";
      expect(isReadOnlySQL(sql, "mysql")).toBe(true);
    });
  });

  describe("CTE with mutating operations", () => {
    it("should reject UPDATE inside a CTE", () => {
      const sql = "WITH updated AS (UPDATE contracts SET site_location_postcode = 'SW11' WHERE id = 1 RETURNING id) SELECT * FROM updated";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should reject DELETE inside a CTE", () => {
      const sql = "WITH deleted AS (DELETE FROM users WHERE id = 1 RETURNING *) SELECT * FROM deleted";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should reject INSERT inside a CTE", () => {
      const sql = "WITH inserted AS (INSERT INTO users (name) VALUES ('test') RETURNING *) SELECT * FROM inserted";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should allow a pure SELECT CTE", () => {
      const sql = "WITH cte AS (SELECT * FROM users) SELECT * FROM cte";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should reject DROP inside a CTE-like construct", () => {
      const sql = "WITH x AS (SELECT 1) DROP TABLE users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(false);
    });

    it("should not be fooled by mutating keywords in string literals", () => {
      const sql = "SELECT * FROM users WHERE name = 'UPDATE me'";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should not be fooled by mutating keywords in comments", () => {
      const sql = "/* UPDATE users SET x = 1 */ SELECT * FROM users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should allow REPLACE() as a string function in SELECT", () => {
      const sql = "SELECT REPLACE(name, 'a', 'b') FROM users";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should allow REPLACE() as a string function inside a WITH CTE", () => {
      const sql = "WITH cte AS (SELECT REPLACE(name, 'a', 'b') AS name FROM users) SELECT * FROM cte";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should reject REPLACE INTO as a mutating statement", () => {
      const sql = "REPLACE INTO users (id, name) VALUES (1, 'test')";
      expect(isReadOnlySQL(sql, "mysql")).toBe(false);
    });

    it("should allow a CTE named 'replace' in Postgres", () => {
      const sql = "WITH replace AS (SELECT 1) SELECT * FROM replace";
      expect(isReadOnlySQL(sql, "postgres")).toBe(true);
    });

    it("should allow a CTE named 'replace' in MySQL", () => {
      const sql = "WITH replace AS (SELECT 1) SELECT * FROM replace";
      expect(isReadOnlySQL(sql, "mysql")).toBe(true);
    });

    it("should reject REPLACE (non-function) inside WITH in MySQL", () => {
      const sql = "WITH cte AS (SELECT 1) REPLACE INTO users VALUES (1, 'test')";
      expect(isReadOnlySQL(sql, "mysql")).toBe(false);
    });

    it("should reject REPLACE (non-function) inside WITH in SQLite", () => {
      const sql = "WITH cte AS (SELECT 1) REPLACE INTO users VALUES (1, 'test')";
      expect(isReadOnlySQL(sql, "sqlite")).toBe(false);
    });

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

    it("should allow EXPLAIN (ANALYZE false) with DML (not executed)", () => {
      expect(isReadOnlySQL("EXPLAIN (ANALYZE false) DELETE FROM users", "postgres")).toBe(true);
    });

    it("should allow EXPLAIN (ANALYZE off) with DML (not executed)", () => {
      expect(isReadOnlySQL("EXPLAIN (ANALYZE off) DELETE FROM users", "postgres")).toBe(true);
    });
  });

  describe("SELECT INTO", () => {
    it("should reject SELECT INTO (Postgres table creation)", () => {
      expect(isReadOnlySQL("SELECT * INTO new_table FROM users", "postgres")).toBe(false);
    });

    it("should reject SELECT INTO OUTFILE (MySQL)", () => {
      expect(isReadOnlySQL("SELECT * INTO OUTFILE '/tmp/data.csv' FROM users", "mysql")).toBe(false);
    });

    it("should reject SELECT INTO with WHERE clause", () => {
      expect(isReadOnlySQL("SELECT id, name INTO backup_table FROM users WHERE active = true", "sqlserver")).toBe(false);
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
    it("should reject MySQL conditional comment containing DELETE", () => {
      expect(isReadOnlySQL("/*!50000 DELETE FROM users WHERE 1=1 */", "mysql")).toBe(false);
    });

    it("should reject MySQL conditional comment containing DROP", () => {
      expect(isReadOnlySQL("/*!50000 DROP TABLE users */", "mysql")).toBe(false);
    });

    it("should reject MariaDB conditional comment containing DELETE", () => {
      expect(isReadOnlySQL("/*!50000 DELETE FROM users */", "mariadb")).toBe(false);
    });

    it("should reject even SELECT inside MySQL conditional comment (safe default)", () => {
      // Conditional comment syntax is preserved as plain text, so the first
      // word includes the /*! prefix — safer to deny than to parse the body.
      expect(isReadOnlySQL("/*!50000 SELECT 1 */", "mysql")).toBe(false);
    });

    it("should still strip regular comments for MySQL", () => {
      expect(isReadOnlySQL("/* comment */ SELECT 1", "mysql")).toBe(true);
    });

    it("should reject conditional comment without version number", () => {
      expect(isReadOnlySQL("/*! DELETE FROM users */", "mysql")).toBe(false);
    });

    it("should reject MariaDB M-bang executable comment", () => {
      expect(isReadOnlySQL("/*M! DELETE FROM users */", "mariadb")).toBe(false);
    });

    it("should reject MariaDB M-bang executable comment on MySQL dialect", () => {
      expect(isReadOnlySQL("/*M! DROP TABLE users */", "mysql")).toBe(false);
    });
  });

  describe("dangerous function blocking", () => {
    // PostgreSQL filesystem functions
    it("should reject pg_read_file", () => {
      expect(isReadOnlySQL("SELECT pg_read_file('/etc/passwd', 0, 100)", "postgres")).toBe(false);
    });

    it("should reject pg_read_binary_file", () => {
      expect(isReadOnlySQL("SELECT pg_read_binary_file('/etc/shadow')", "postgres")).toBe(false);
    });

    it("should reject pg_ls_dir", () => {
      expect(isReadOnlySQL("SELECT pg_ls_dir('/etc')", "postgres")).toBe(false);
    });

    it("should reject pg_stat_file", () => {
      expect(isReadOnlySQL("SELECT pg_stat_file('/etc/passwd')", "postgres")).toBe(false);
    });

    it("should reject pg_ls_waldir", () => {
      expect(isReadOnlySQL("SELECT pg_ls_waldir()", "postgres")).toBe(false);
    });

    // PostgreSQL configuration and connection management
    it("should reject set_config", () => {
      expect(isReadOnlySQL("SELECT set_config('log_statement', 'none', false)", "postgres")).toBe(false);
    });

    it("should reject pg_terminate_backend", () => {
      expect(isReadOnlySQL("SELECT pg_terminate_backend(12345)", "postgres")).toBe(false);
    });

    it("should reject pg_cancel_backend", () => {
      expect(isReadOnlySQL("SELECT pg_cancel_backend(12345)", "postgres")).toBe(false);
    });

    it("should reject pg_reload_conf", () => {
      expect(isReadOnlySQL("SELECT pg_reload_conf()", "postgres")).toBe(false);
    });

    // PostgreSQL large object and file write functions
    it("should reject lo_export", () => {
      expect(isReadOnlySQL("SELECT lo_export(12345, '/tmp/evil.sh')", "postgres")).toBe(false);
    });

    it("should reject lo_import", () => {
      expect(isReadOnlySQL("SELECT lo_import('/etc/passwd')", "postgres")).toBe(false);
    });

    it("should reject pg_file_write", () => {
      expect(isReadOnlySQL("SELECT pg_file_write('/tmp/x', 'data', false)", "postgres")).toBe(false);
    });

    // PostgreSQL dblink
    it("should reject dblink_exec", () => {
      expect(isReadOnlySQL("SELECT dblink_exec('host=evil.com', 'DROP TABLE users')", "postgres")).toBe(false);
    });

    it("should reject dblink", () => {
      expect(isReadOnlySQL("SELECT * FROM dblink('host=evil.com', 'SELECT secret FROM keys') AS t(s text)", "postgres")).toBe(false);
    });

    // PostgreSQL functions inside WITH/subqueries
    it("should reject pg_read_file inside a CTE", () => {
      expect(isReadOnlySQL("WITH data AS (SELECT pg_read_file('/etc/passwd')) SELECT * FROM data", "postgres")).toBe(false);
    });

    it("should reject pg_read_file in subquery", () => {
      expect(isReadOnlySQL("SELECT * FROM (SELECT pg_read_file('/etc/hosts')) AS t", "postgres")).toBe(false);
    });

    // Ensure normal functions are NOT blocked
    it("should allow normal aggregate functions", () => {
      expect(isReadOnlySQL("SELECT count(*), avg(salary) FROM employees", "postgres")).toBe(true);
    });

    it("should allow string functions", () => {
      expect(isReadOnlySQL("SELECT upper(name), length(name) FROM users", "postgres")).toBe(true);
    });

    it("should allow pg_catalog queries", () => {
      expect(isReadOnlySQL("SELECT * FROM pg_catalog.pg_tables", "postgres")).toBe(true);
    });

    it("should allow current_setting (read-only counterpart of set_config)", () => {
      expect(isReadOnlySQL("SELECT current_setting('server_version')", "postgres")).toBe(true);
    });

    // MySQL/MariaDB dangerous functions
    it("should reject LOAD_FILE in MySQL", () => {
      expect(isReadOnlySQL("SELECT load_file('/etc/passwd')", "mysql")).toBe(false);
    });

    it("should reject LOAD_FILE in MariaDB", () => {
      expect(isReadOnlySQL("SELECT load_file('/etc/passwd')", "mariadb")).toBe(false);
    });

    it("should reject SELECT INTO OUTFILE in MySQL", () => {
      expect(isReadOnlySQL("SELECT * FROM users INTO OUTFILE '/tmp/dump.csv'", "mysql")).toBe(false);
    });

    it("should reject SELECT INTO DUMPFILE in MySQL", () => {
      expect(isReadOnlySQL("SELECT * FROM users INTO DUMPFILE '/tmp/dump.bin'", "mysql")).toBe(false);
    });

    // SQL Server dangerous functions
    it("should reject xp_cmdshell in SQL Server", () => {
      expect(isReadOnlySQL("SELECT * FROM xp_cmdshell('whoami')", "sqlserver")).toBe(false);
    });

    it("should reject xp_dirtree in SQL Server", () => {
      expect(isReadOnlySQL("SELECT * FROM xp_dirtree('C:\\')", "sqlserver")).toBe(false);
    });

    it("should reject OPENROWSET in SQL Server", () => {
      expect(isReadOnlySQL("SELECT * FROM openrowset('SQLOLEDB','server';'user';'pass','SELECT 1')", "sqlserver")).toBe(false);
    });

    // Cross-dialect: dangerous PG functions should NOT be blocked for other dialects
    it("should not block pg_read_file in MySQL (not a MySQL function)", () => {
      expect(isReadOnlySQL("SELECT pg_read_file FROM some_table", "mysql")).toBe(true);
    });

    it("should not block load_file in PostgreSQL (not a PG function)", () => {
      expect(isReadOnlySQL("SELECT load_file FROM some_table", "postgres")).toBe(true);
    });
  });
});
