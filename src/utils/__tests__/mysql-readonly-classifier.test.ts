import { describe, expect, it } from "vitest";
import { classifyMySQLReadonlyQuery } from "../mysql-readonly-classifier.js";
import { planMySQLStatements } from "../mysql-sql-scanner.js";

function classify(sql: string, sqlMode = "", parameters: readonly unknown[] = []) {
  return classifyMySQLReadonlyQuery(
    planMySQLStatements(sql, parameters),
    sqlMode,
    parameters
  );
}

describe("classifyMySQLReadonlyQuery", () => {
  it.each([
    "SELECT SLEEP(1)",
    "SELECT sLeEp (1)",
    "SELECT mysql.SLEEP(1)",
    "SELECT `SLEEP`(1)",
    "SELECT BENCHMARK(1, SHA2('x', 256))",
    "SELECT GET_LOCK('x', 1)",
    "SELECT RELEASE_LOCK('x')",
    "SELECT RELEASE_ALL_LOCKS()",
    "SELECT LOAD_FILE('/tmp/x')",
    "SELECT SYS_EXEC('id')",
    "SELECT SYS_EVAL('id')",
    "SELECT /*!50000 SLEEP(1) */ 1",
    "SELECT SLEEP/* comment */(1)",
    "SELECT SLEEP-- comment\n(1)",
    "SELECT SLEEP# comment\n(1)",
    "SELECT SLEEP-- comment\r\n(1)",
    "SELECT SLEEP# comment\r\n(1)",
    "SELECT 1 -- comment\r, SLEEP(0)",
    "SELECT 1 # comment\r, SLEEP(0)",
    "SELECT mysql.\nSLEEP\n(\n1\n)",
    "SELECT mysql.`SLEEP`(1)",
    "SELECT `x\\`, SLEEP(1)",
  ])("rejects dangerous function invocation %s", (sql) => {
    expect(classify(sql)).toEqual({ allowed: false, category: "dangerous_function" });
  });

  it.each([
    "SELECT 'SLEEP(1)'",
    "SELECT \"BENCHMARK(1, 1)\"",
    "SELECT 'escaped \\' SLEEP(1)'",
    "SELECT 'doubled '' SLEEP(1)'",
    "SELECT /* SLEEP(1) */ 1",
    "SELECT /*M! SELECT SLEEP(1) */ 1",
    "SELECT /*+ SLEEP(1) */ 1",
    "SELECT SLEEP FROM metrics",
    "SELECT `SLEEP` FROM metrics",
    "SELECT 1 AS SLEEP",
    "SELECT my_sleep(1)",
    "SELECT IS_FREE_LOCK('x')",
    "SELECT IS_USED_LOCK('x')",
  ])("allows non-invocation %s", (sql) => {
    expect(classify(sql)).toEqual({ allowed: true });
  });

  it.each(["NO_BACKSLASH_ESCAPES", "ANSI_QUOTES", "STRICT_TRANS_TABLES,ANSI_QUOTES"])(
    "fails closed for unsupported sql_mode %s",
    (sqlMode) => {
      expect(classify("SELECT 1", sqlMode)).toEqual({
        allowed: false,
        category: "unsupported_sql_mode",
      });
    }
  );

  it("supports IGNORE_SPACE", () => {
    expect(classify("SELECT SLEEP (1)", "STRICT_TRANS_TABLES,IGNORE_SPACE")).toEqual({
      allowed: false,
      category: "dangerous_function",
    });
  });

  it.each([
    ["SLEEP", "SELECT ??(1)", ["SLEEP"]],
    ["qualified SLEEP", "SELECT ??(1)", ["mysql.SLEEP"]],
    ["qualified placeholder", "SELECT ??.??(1)", ["mysql", "SLEEP"]],
    ["array tail", "SELECT ??(1)", [["ordinary", "SLEEP"]]],
  ])("rejects a dangerous function supplied through %s", (_, sql, parameters) => {
    expect(classify(sql, "", parameters)).toEqual({
      allowed: false,
      category: "dangerous_function",
    });
  });

  it("does not treat an identifier placeholder as a call without an opening parenthesis", () => {
    expect(classify("SELECT ?? FROM metrics", "", ["SLEEP"])).toEqual({
      allowed: true,
    });
  });
});
