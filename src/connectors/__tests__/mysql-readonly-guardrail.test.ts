import { beforeEach, describe, expect, it, vi } from "vitest";

const mysqlCreatePool = vi.fn();

vi.mock("mysql2/promise", () => ({
  default: {
    get createPool() {
      return mysqlCreatePool;
    },
  },
}));

const { MySQLConnector } = await import("../mysql/index.js");
const { SafeExecutionError } = await import("../../utils/safe-execution-error.js");
const { MySQLStatementPlanError } = await import("../../utils/mysql-sql-scanner.js");

function makePool(version = "8.0.36", options: { sqlMode?: unknown; modeError?: Error } = {}) {
  const statements: string[] = [];
  const conn = {
    query: vi.fn(async (arg: any) => {
      const sql = typeof arg === "string" ? arg : arg.sql;
      statements.push(sql);
      if (sql === "SELECT @@SESSION.sql_mode AS sql_mode") {
        if (options.modeError) throw options.modeError;
        return [[{ sql_mode: options.sqlMode ?? "" }], []];
      }
      return [[{ value: 1 }], []];
    }),
    release: vi.fn(),
    destroy: vi.fn(),
  };
  const pool = {
    query: vi.fn(async () => [[{ version }], []]),
    getConnection: vi.fn(async () => conn),
    end: vi.fn(),
  };
  return { pool, conn, statements };
}

async function connectedConnector(pool: ReturnType<typeof makePool>["pool"]) {
  mysqlCreatePool.mockReturnValue(pool);
  const connector = new MySQLConnector();
  await connector.connect("mysql://user:pass@localhost:3306/db");
  return connector;
}

async function connectedConnectorWithCustomQueryFormat(pool: ReturnType<typeof makePool>["pool"]) {
  mysqlCreatePool.mockReturnValue(pool);
  const connector = new MySQLConnector();
  vi.spyOn(connector.dsnParser, "parse").mockResolvedValue({
    queryFormat: () => "custom",
  } as any);
  await connector.connect("mysql://user:pass@localhost:3306/db");
  return connector;
}

describe("MySQL readonly guardrail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a failed flavor probe to a safe precondition error", async () => {
    const sentinel = "RAW_FLAVOR_PROBE_SENTINEL";
    const { pool } = makePool();
    pool.query.mockRejectedValue(new Error(sentinel));
    mysqlCreatePool.mockReturnValue(pool);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      new MySQLConnector().connect("mysql://user:pass@localhost:3306/db")
    ).rejects.toMatchObject({
      code: "MYSQL_SAFETY_CHECK_FAILED",
      category: "flavor_probe_failed",
    });

    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(sentinel);
    stderr.mockRestore();
  });

  it.each(["5.7.44", "8.0.36", "8.4.10", "9.7.1"])(
    "rejects dangerous functions before BEGIN or user SQL on standard MySQL %s",
    async (version) => {
      const { pool, conn, statements } = makePool(version);
      const connector = await connectedConnector(pool);

      await expect(
        connector.executeSQL("SELECT mysql.SLEEP(1)", { readonly: true })
      ).rejects.toMatchObject({
        kind: "safe_execution_error",
        code: "MYSQL_READONLY_GUARDRAIL",
        category: "dangerous_function",
      });

      expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
      expect(conn.release).toHaveBeenCalledTimes(1);
      expect(conn.destroy).not.toHaveBeenCalled();
    }
  );

  it("rejects a dangerous identifier placeholder before BEGIN or user SQL", async () => {
    const { pool, conn, statements } = makePool();
    const connector = await connectedConnector(pool);

    await expect(
      connector.executeSQL("SELECT ??(1)", { readonly: true }, ["SLEEP"])
    ).rejects.toMatchObject({
      code: "MYSQL_READONLY_GUARDRAIL",
      category: "dangerous_function",
    });

    expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("fails closed on unsupported sql_mode and releases a healthy target", async () => {
    const { pool, conn, statements } = makePool("8.0.36", {
      sqlMode: "STRICT_TRANS_TABLES,ANSI_QUOTES",
    });
    const connector = await connectedConnector(pool);

    await expect(connector.executeSQL("SELECT 1", { readonly: true })).rejects.toMatchObject({
      code: "MYSQL_READONLY_GUARDRAIL",
      category: "unsupported_sql_mode",
    });

    expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("destroys the target when sql_mode cannot be read without leaking the cause", async () => {
    const sentinel = "RAW_DB_SENTINEL";
    const { pool, conn, statements } = makePool("8.0.36", {
      modeError: new Error(sentinel),
    });
    const connector = await connectedConnector(pool);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(connector.executeSQL("SELECT 1", { readonly: true })).rejects.toMatchObject({
      code: "MYSQL_SAFETY_CHECK_FAILED",
      category: "sql_mode_unavailable",
    });

    expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
    expect(conn.release).not.toHaveBeenCalled();
    expect(conn.destroy).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(sentinel);
    stderr.mockRestore();
  });

  it("destroys the target when sql_mode has an invalid protocol shape", async () => {
    const { pool, conn, statements } = makePool("8.0.36", { sqlMode: 123 });
    const connector = await connectedConnector(pool);

    await expect(connector.executeSQL("SELECT 1", { readonly: true })).rejects.toMatchObject({
      code: "MYSQL_SAFETY_CHECK_FAILED",
      category: "sql_mode_unavailable",
    });

    expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
    expect(conn.release).not.toHaveBeenCalled();
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsupported parameter plan before BEGIN and releases the target", async () => {
    const { pool, conn, statements } = makePool();
    const connector = await connectedConnector(pool);

    await expect(connector.executeSQL("SELECT ?", { readonly: true }, [])).rejects.toMatchObject({
      code: "MYSQL_SAFETY_CHECK_FAILED",
      category: "statement_plan_unsupported",
    });

    expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("rejects custom mysql2 queryFormat before BEGIN and releases the target", async () => {
    const { pool, conn, statements } = makePool();
    const connector = await connectedConnectorWithCustomQueryFormat(pool);

    await expect(connector.executeSQL("SELECT ?", { readonly: true }, [1])).rejects.toMatchObject({
      code: "MYSQL_SAFETY_CHECK_FAILED",
      category: "statement_plan_unsupported",
    });

    expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("destroys the target when statement-plan invariants fail", async () => {
    const { pool, conn, statements } = makePool();
    const connector = await connectedConnector(pool);
    vi.spyOn(connector as any, "planReadonlyStatements").mockImplementation(() => {
      throw new MySQLStatementPlanError("statement_plan_invariant_failed");
    });

    await expect(connector.executeSQL("SELECT 1", { readonly: true })).rejects.toMatchObject({
      code: "MYSQL_SAFETY_CHECK_FAILED",
      category: "statement_plan_invariant_failed",
    });

    expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
    expect(conn.release).not.toHaveBeenCalled();
    expect(conn.destroy).toHaveBeenCalledTimes(1);
  });

  it("checks sql_mode before constructing the statement plan", async () => {
    const { pool, conn, statements } = makePool("8.0.36", {
      sqlMode: "ANSI_QUOTES",
    });
    const connector = await connectedConnector(pool);
    const planner = vi.spyOn(connector as any, "planReadonlyStatements");

    await expect(connector.executeSQL("SELECT ?", { readonly: true }, [])).rejects.toMatchObject({
      code: "MYSQL_READONLY_GUARDRAIL",
      category: "unsupported_sql_mode",
    });

    expect(planner).not.toHaveBeenCalled();
    expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.destroy).not.toHaveBeenCalled();
  });

  it("does not send comment-only plans to the server", async () => {
    const { pool, conn, statements } = makePool();
    const connector = await connectedConnector(pool);

    await expect(connector.executeSQL("/* ? */", { readonly: true }, ["ignored"])).resolves.toEqual(
      { rows: [], rowCount: 0 }
    );

    expect(statements).toEqual(["SELECT @@SESSION.sql_mode AS sql_mode"]);
    expect(conn.release).toHaveBeenCalledTimes(1);
  });

  it("does not write SQL, parameters, or raw database errors to stderr", async () => {
    const sqlSentinel = "SQL_SENTINEL";
    const parameterSentinel = "PARAMETER_SENTINEL";
    const databaseSentinel = "DATABASE_SENTINEL";
    const { pool, conn } = makePool();
    conn.query.mockImplementation(async (arg: any) => {
      const statement = typeof arg === "string" ? arg : arg.sql;
      if (statement === "SELECT @@SESSION.sql_mode AS sql_mode") {
        return [[{ sql_mode: "" }], []];
      }
      if (statement.includes(sqlSentinel)) {
        throw new Error(databaseSentinel);
      }
      return [[{ value: 1 }], []];
    });
    const connector = await connectedConnector(pool);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      connector.executeSQL(`SELECT ? AS value /* ${sqlSentinel} */`, { readonly: true }, [
        parameterSentinel,
      ])
    ).rejects.toThrow(databaseSentinel);

    const output = stderr.mock.calls.flat().join(" ");
    expect(output).not.toContain(sqlSentinel);
    expect(output).not.toContain(parameterSentinel);
    expect(output).not.toContain(databaseSentinel);
    stderr.mockRestore();
  });

  it.each([
    ["8.0.11-TiDB-v7.5.0", "START TRANSACTION"],
    ["11.4.2-MariaDB-ubu2404", "START TRANSACTION READ ONLY"],
    ["not-a-version", "START TRANSACTION READ ONLY"],
  ])("keeps the legacy path for %s", async (version, beginStatement) => {
    const { pool, statements } = makePool(version);
    const connector = await connectedConnector(pool);

    await connector.executeSQL("SELECT SLEEP(0)", { readonly: true });

    expect(statements).not.toContain("SELECT @@SESSION.sql_mode AS sql_mode");
    expect(statements[0]).toBe(beginStatement);
    expect(statements).toContain("SELECT SLEEP(0)");
  });

  it("exposes a real SafeExecutionError instance", async () => {
    const { pool } = makePool();
    const connector = await connectedConnector(pool);

    await expect(
      connector.executeSQL("SELECT SLEEP(1)", { readonly: true })
    ).rejects.toBeInstanceOf(SafeExecutionError);
  });
});
