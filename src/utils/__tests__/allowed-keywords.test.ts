import { describe, it, expect } from "vitest";
import { isReadOnlySQL } from "../allowed-keywords.js";
import { splitSQLStatements } from "../sql-parser.js";
import type { ConnectorType } from "../../connectors/interface.js";

// Mirrors areAllStatementsReadOnly in src/tools/execute-sql.ts: the real
// enforcement splits a batch into statements first, then checks each one.
function areAllStatementsReadOnly(sql: string, connectorType: ConnectorType): boolean {
  return splitSQLStatements(sql, connectorType).every(s => isReadOnlySQL(s, connectorType));
}

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
    it("should reject EXEC as a standalone statement", () => {
      expect(isReadOnlySQL("EXEC('DELETE FROM users')", "sqlserver")).toBe(false);
    });

    it("should reject EXECUTE as a standalone statement", () => {
      expect(isReadOnlySQL("EXECUTE('DELETE FROM users')", "sqlserver")).toBe(false);
    });

    it("should reject EXEC sp_executesql", () => {
      expect(isReadOnlySQL("EXEC sp_executesql N'DELETE FROM users'", "sqlserver")).toBe(false);
    });

    it("should reject EXEC inside a CTE", () => {
      expect(isReadOnlySQL("WITH cte AS (SELECT 1) EXEC('DELETE FROM users')", "sqlserver")).toBe(false);
    });

    it("should reject EXECUTE inside a CTE", () => {
      expect(isReadOnlySQL("WITH cte AS (SELECT 1) EXECUTE('DELETE FROM users')", "sqlserver")).toBe(false);
    });

    it("should reject implicit sp_executesql (no EXEC prefix) inside a CTE", () => {
      expect(isReadOnlySQL("WITH cte AS (SELECT 1) sp_executesql N'DELETE FROM users'", "sqlserver")).toBe(false);
    });

    it("should reject xp_cmdshell inside a CTE", () => {
      expect(isReadOnlySQL("WITH cte AS (SELECT 1) xp_cmdshell 'del *.*'", "sqlserver")).toBe(false);
    });

    it("should not reject EXEC/EXECUTE inside string literals", () => {
      expect(isReadOnlySQL("SELECT * FROM users WHERE name = 'EXEC is a keyword'", "sqlserver")).toBe(true);
    });

    it("should not reject EXEC/EXECUTE in comments", () => {
      expect(isReadOnlySQL("/* EXEC('DROP TABLE users') */ SELECT 1", "sqlserver")).toBe(true);
    });

    it("should reject EXEC after multi-statement split", () => {
      expect(areAllStatementsReadOnly("SELECT 1; EXEC('DELETE FROM users')", "sqlserver")).toBe(false);
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

  describe("SQLite PRAGMA write bypass prevention", () => {
    it("should allow query-form introspection pragmas", () => {
      expect(isReadOnlySQL("PRAGMA table_info(users)", "sqlite")).toBe(true);
      expect(isReadOnlySQL("PRAGMA user_version", "sqlite")).toBe(true);
      expect(isReadOnlySQL("PRAGMA journal_mode", "sqlite")).toBe(true);
    });

    it("should reject assignment-form pragma writing the database header", () => {
      expect(isReadOnlySQL("PRAGMA user_version = 1337", "sqlite")).toBe(false);
      expect(isReadOnlySQL("PRAGMA application_id = 1", "sqlite")).toBe(false);
    });

    it("should reject assignment-form pragma changing durable state", () => {
      expect(isReadOnlySQL("PRAGMA journal_mode = WAL", "sqlite")).toBe(false);
      expect(isReadOnlySQL("PRAGMA foreign_keys = OFF", "sqlite")).toBe(false);
      expect(isReadOnlySQL("PRAGMA secure_delete = ON", "sqlite")).toBe(false);
    });

    it("should reject assignment-form pragma disabling the read-only backstop", () => {
      expect(isReadOnlySQL("PRAGMA query_only = OFF", "sqlite")).toBe(false);
      expect(isReadOnlySQL("PRAGMA writable_schema = ON", "sqlite")).toBe(false);
    });

    it("should reject assignment-form pragma without surrounding spaces", () => {
      expect(isReadOnlySQL("PRAGMA user_version=1", "sqlite")).toBe(false);
    });

    it("should reject the parenthesized setter form (equivalent to '= value')", () => {
      // SQLite accepts `PRAGMA name(value)` as an alias for `PRAGMA name = value`.
      expect(isReadOnlySQL("PRAGMA user_version(1337)", "sqlite")).toBe(false);
      expect(isReadOnlySQL("PRAGMA journal_mode(wal)", "sqlite")).toBe(false);
      expect(isReadOnlySQL("PRAGMA writable_schema(1)", "sqlite")).toBe(false);
    });

    it("should reject disabling the backstop via the parenthesized form", () => {
      expect(isReadOnlySQL("PRAGMA query_only(0)", "sqlite")).toBe(false);
      expect(isReadOnlySQL("PRAGMA query_only(OFF)", "sqlite")).toBe(false);
    });

    it("should still allow introspection pragmas that take a name argument", () => {
      expect(isReadOnlySQL("PRAGMA table_info(users)", "sqlite")).toBe(true);
      expect(isReadOnlySQL("PRAGMA index_list(users)", "sqlite")).toBe(true);
      expect(isReadOnlySQL("PRAGMA foreign_key_list(orders)", "sqlite")).toBe(true);
    });
  });

  describe("MySQL/MariaDB -- comment bypass prevention", () => {
    // MySQL/MariaDB only treat "--" as a comment when followed by whitespace.
    // "SELECT 1--1;DROP TABLE t" is one statement to a naive parser but two to
    // the engine, so after splitting the hidden DROP must be checked and rejected.
    it("should split and reject a DROP hidden after -- without whitespace (mysql)", () => {
      expect(splitSQLStatements("SELECT 1--1;DROP TABLE victim", "mysql")).toHaveLength(2);
      expect(areAllStatementsReadOnly("SELECT 1--1;DROP TABLE victim", "mysql")).toBe(false);
    });

    it("should split and reject a DROP hidden after -- without whitespace (mariadb)", () => {
      expect(areAllStatementsReadOnly("SELECT 1--1;DROP TABLE victim", "mariadb")).toBe(false);
    });

    it("should still treat '-- ' followed by whitespace as a comment (mysql)", () => {
      expect(splitSQLStatements("SELECT 1 -- a comment;DROP TABLE t", "mysql")).toHaveLength(1);
      expect(areAllStatementsReadOnly("SELECT 1 -- a comment", "mysql")).toBe(true);
    });

    it("should still treat the DML-in-comment as inert for postgres (-- is always a comment)", () => {
      expect(splitSQLStatements("SELECT 1--1;DROP TABLE victim", "postgres")).toHaveLength(1);
      expect(areAllStatementsReadOnly("SELECT 1--1;DROP TABLE victim", "postgres")).toBe(true);
    });
  });
});
