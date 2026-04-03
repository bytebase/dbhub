import { describe, it, expect } from "vitest";
import { quoteIdentifier } from "../../utils/identifier-quoter.js";

/**
 * Verify that MySQL/MariaDB SHOW CREATE PROCEDURE/FUNCTION statements
 * use properly quoted identifiers. Procedure and schema names containing
 * spaces, reserved words, or special characters cause syntax errors
 * without backtick quoting.
 *
 * The connectors build SQL like:
 *   SHOW CREATE PROCEDURE ${quotedSchema}.${quotedProcName}
 *
 * This test validates the quoting produces valid SQL fragments.
 */
describe("SHOW CREATE PROCEDURE identifier quoting", () => {
  describe("MySQL/MariaDB backtick quoting for procedure names", () => {
    it("should quote names with spaces", () => {
      const schema = quoteIdentifier("my schema", "mysql");
      const proc = quoteIdentifier("my procedure", "mysql");
      const sql = `SHOW CREATE PROCEDURE ${schema}.${proc}`;
      expect(sql).toBe("SHOW CREATE PROCEDURE `my schema`.`my procedure`");
    });

    it("should quote reserved words", () => {
      const schema = quoteIdentifier("order", "mysql");
      const proc = quoteIdentifier("select", "mysql");
      const sql = `SHOW CREATE PROCEDURE ${schema}.${proc}`;
      expect(sql).toBe("SHOW CREATE PROCEDURE `order`.`select`");
    });

    it("should escape backticks in names", () => {
      const schema = quoteIdentifier("db`name", "mysql");
      const proc = quoteIdentifier("proc`name", "mysql");
      const sql = `SHOW CREATE PROCEDURE ${schema}.${proc}`;
      expect(sql).toBe("SHOW CREATE PROCEDURE `db``name`.`proc``name`");
    });

    it("should quote names with dots", () => {
      const schema = quoteIdentifier("my.db", "mysql");
      const proc = quoteIdentifier("calc.totals", "mysql");
      const sql = `SHOW CREATE FUNCTION ${schema}.${proc}`;
      expect(sql).toBe("SHOW CREATE FUNCTION `my.db`.`calc.totals`");
    });

    it("should also work for MariaDB (same syntax)", () => {
      const schema = quoteIdentifier("test schema", "mariadb");
      const proc = quoteIdentifier("get-data", "mariadb");
      const sql = `SHOW CREATE PROCEDURE ${schema}.${proc}`;
      expect(sql).toBe("SHOW CREATE PROCEDURE `test schema`.`get-data`");
    });
  });

  describe("unquoted identifiers break with special characters", () => {
    it("demonstrates the problem: spaces in names produce invalid SQL", () => {
      const schema = "my schema";
      const proc = "my procedure";
      const unquotedSQL = `SHOW CREATE PROCEDURE ${schema}.${proc}`;
      // This SQL is invalid and will cause MySQL syntax errors
      expect(unquotedSQL).toBe("SHOW CREATE PROCEDURE my schema.my procedure");
      // The database would parse "my" as the schema and "schema.my" as noise
    });

    it("demonstrates the problem: reserved words produce invalid SQL", () => {
      const schema = "order";
      const proc = "select";
      const unquotedSQL = `SHOW CREATE PROCEDURE ${schema}.${proc}`;
      // "order" and "select" are reserved words; MySQL will misparse this
      expect(unquotedSQL).toBe("SHOW CREATE PROCEDURE order.select");
    });
  });
});
