import { describe, it, expect } from "vitest";
import {
  classifyStatement,
  classifySQL,
  policyFromReadonly,
  isReadOnlyPolicy,
  sqlVerdict,
} from "../sql-access-policy.js";

describe("classifyStatement", () => {
  it.each([
    ["SELECT * FROM users", "read"],
    ["WITH t AS (SELECT 1) SELECT * FROM t", "read"],
    ["EXPLAIN SELECT 1", "read"],
    ["INSERT INTO users (name) VALUES ('x')", "dml"],
    ["UPDATE users SET name = 'x'", "dml"],
    ["DELETE FROM users", "dml"],
    ["CREATE TABLE t (id INT)", "ddl"],
    ["DROP TABLE users", "ddl"],
    ["ALTER TABLE users ADD COLUMN x INT", "ddl"],
    ["TRUNCATE TABLE users", "ddl"],
    ["GRANT SELECT ON users TO reader", "admin"],
    ["REVOKE SELECT ON users FROM reader", "admin"],
    ["VACUUM", "unknown"],
  ] as const)("classifies %j as %s (postgres)", (sql, expected) => {
    expect(classifyStatement(sql, "postgres")).toBe(expected);
  });

  it("classifies DML hidden in a CTE as dml", () => {
    expect(
      classifyStatement("WITH t AS (DELETE FROM users RETURNING *) SELECT * FROM t", "postgres")
    ).toBe("dml");
  });

  it("classifies REPLACE INTO as dml on MySQL but read-only REPLACE() stays read", () => {
    expect(classifyStatement("REPLACE INTO users VALUES (1, 'x')", "mysql")).toBe("dml");
    expect(classifyStatement("SELECT REPLACE(name, 'a', 'b') FROM users", "mysql")).toBe("read");
  });

  it("classifies T-SQL dynamic SQL and pass-through sources as admin on SQL Server only", () => {
    expect(classifyStatement("EXEC sp_executesql N'SELECT 1'", "sqlserver")).toBe("admin");
    expect(classifyStatement("SELECT * FROM OPENQUERY(lnk, 'SELECT 1')", "sqlserver")).toBe("admin");
  });

  it("classifies SELECT-invocable escape-hatch functions as admin (issue #377)", () => {
    // File/lock functions that a read-only transaction does not contain.
    expect(classifyStatement("SELECT LOAD_FILE('/etc/passwd')", "mysql")).toBe("admin");
    expect(classifyStatement("SELECT get_lock('x', 10)", "mariadb")).toBe("admin");
    expect(classifyStatement("SELECT pg_read_file('/etc/passwd')", "postgres")).toBe("admin");
    // Call position only: a column of the same name stays read.
    expect(classifyStatement("SELECT load_file FROM t", "mysql")).toBe("read");
  });

  it("keeps a column named openquery read-only on SQL Server", () => {
    expect(classifyStatement("SELECT openquery FROM t", "sqlserver")).toBe("read");
  });
});

describe("classifySQL (multi-statement)", () => {
  it("takes the most privileged class across statements", () => {
    expect(classifySQL("SELECT 1; INSERT INTO t VALUES (1)", "postgres")).toBe("dml");
    expect(classifySQL("SELECT 1; DROP TABLE t; INSERT INTO t VALUES (1)", "postgres")).toBe("ddl");
    expect(classifySQL("SELECT 1; SELECT 2", "postgres")).toBe("read");
  });
});

describe("policyFromReadonly", () => {
  it("readonly=true denies everything beyond read", () => {
    const policy = policyFromReadonly(true);
    expect(isReadOnlyPolicy(policy)).toBe(true);
    expect(policy.read).toBe("allow");
    expect(policy.dml).toBe("deny");
    expect(policy.ddl).toBe("deny");
    expect(policy.admin).toBe("deny");
    expect(policy.unknown).toBe("deny");
  });

  it.each([false, undefined] as const)("readonly=%s allows everything", (readonly) => {
    const policy = policyFromReadonly(readonly);
    expect(isReadOnlyPolicy(policy)).toBe(false);
    expect(Object.values(policy).every((v) => v === "allow")).toBe(true);
  });
});

describe("sqlVerdict", () => {
  const readOnly = policyFromReadonly(true);
  const writable = policyFromReadonly(false);

  it("denies writes and unknown statements under a read-only policy", () => {
    expect(sqlVerdict(readOnly, "SELECT 1", "postgres")).toBe("allow");
    expect(sqlVerdict(readOnly, "INSERT INTO t VALUES (1)", "postgres")).toBe("deny");
    expect(sqlVerdict(readOnly, "SELECT 1; DROP TABLE t", "postgres")).toBe("deny");
    expect(sqlVerdict(readOnly, "VACUUM", "postgres")).toBe("deny");
  });

  it("allows everything under a writable policy", () => {
    expect(sqlVerdict(writable, "DROP TABLE t", "postgres")).toBe("allow");
    expect(sqlVerdict(writable, "GRANT ALL ON t TO x", "postgres")).toBe("allow");
  });
});
