import { describe, it, expect } from "vitest";
import { parseReadonlySessionSQL } from "../readonly-session-sql.js";

describe("parseReadonlySessionSQL", () => {
  describe("accepted forms", () => {
    it.each(["mysql", "mariadb"] as const)("splits SET SESSION statements in order for %s", dialect => {
      const sql = `
        SET SESSION max_execution_time = 30000;
        SET SESSION lock_wait_timeout = 5;
      `;
      expect(parseReadonlySessionSQL(sql, dialect)).toEqual([
        "SET SESSION max_execution_time = 30000",
        "SET SESSION lock_wait_timeout = 5",
      ]);
    });

    it("accepts a comma inside a string value", () => {
      expect(
        parseReadonlySessionSQL("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_DATE'", "mysql")
      ).toHaveLength(1);
    });

    it("ignores a leading comment", () => {
      expect(parseReadonlySessionSQL("-- guardrails\nSET SESSION lock_wait_timeout = 5", "mysql")).toHaveLength(1);
    });
  });

  describe("rejected statements", () => {
    it.each([
      ["a query", "SELECT 1"],
      ["a write", "DELETE FROM users"],
      ["a SET without SESSION", "SET max_execution_time = 1"],
      ["a GLOBAL assignment", "SET GLOBAL max_execution_time = 1"],
      ["a subquery value", "SET SESSION max_execution_time = (SELECT 1)"],
      ["a second assignment in another scope", "SET SESSION max_execution_time = 1, GLOBAL max_connections = 1"],
      ["an executable comment hiding a subquery", "SET SESSION max_execution_time = 1 /*!, b = (SELECT 1) */"],
      ["a keyword hidden in a comment", "/* SET SESSION x = 1 */ DELETE FROM users"],
    ])("rejects %s", (_label, sql) => {
      expect(() => parseReadonlySessionSQL(sql, "mysql")).toThrow("SET SESSION name = value");
    });

    it("rejects a second statement after a valid one", () => {
      expect(() =>
        parseReadonlySessionSQL("SET SESSION lock_wait_timeout = 5; DROP TABLE users", "mysql")
      ).toThrow("got: DROP TABLE users");
    });

    it.each([
      ["mysql", "SET SESSION transaction_read_only = 0"],
      ["mariadb", "SET SESSION tx_read_only = 0"],
      ["mysql", "SET SESSION autocommit = 0"],
      ["mariadb", "SET SESSION completion_type = 2"],
    ] as const)("rejects a transaction-control setting on %s: %s", (dialect, sql) => {
      expect(() => parseReadonlySessionSQL(sql, dialect)).toThrow("controls the transaction");
    });

    it("rejects an empty value", () => {
      expect(() => parseReadonlySessionSQL("  ;  ", "mysql")).toThrow("empty");
    });

    it.each(["postgres", "sqlserver", "oracle", "sqlite"] as const)(
      "rejects the unsupported dialect %s",
      dialect => {
        expect(() => parseReadonlySessionSQL("SET SESSION lock_wait_timeout = 5", dialect)).toThrow(
          "not supported"
        );
      }
    );
  });
});
