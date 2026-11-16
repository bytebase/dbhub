import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VERSION_COMMENT_QUERY } from "../../utils/readonly-transaction.js";
import { getDorisHealthCheck } from "../doris-health-check.js";
import { getMySQLFamilyHealthCheck } from "../mysql-family-health-check.js";

const mysqlCreatePool = vi.fn();
const mariadbCreatePool = vi.fn();
vi.mock("mysql2/promise", () => ({
  default: {
    get createPool() {
      return mysqlCreatePool;
    },
  },
}));
vi.mock("mariadb", () => ({ createPool: (...args: any[]) => mariadbCreatePool(...args) }));
vi.mock("../doris-health-check.js", () => ({
  getDorisHealthCheck: vi.fn(async () => ({ nodes: { frontends: [], backends: [] } })),
}));
vi.mock("../mysql-family-health-check.js", () => ({
  getMySQLFamilyHealthCheck: vi.fn(async () => ({ notes: ["native"] })),
}));
const { MySQLConnector } = await import("../mysql/index.js");
const { MariaDBConnector } = await import("../mariadb/index.js");

describe.each([
  {
    name: "mysql",
    Connector: MySQLConnector,
    createPool: mysqlCreatePool,
    wrap: (rows: any[]) => [rows, []],
  },
  {
    name: "mariadb",
    Connector: MariaDBConnector,
    createPool: mariadbCreatePool,
    wrap: (rows: any[]) => rows,
  },
])("$name health routing", ({ name, Connector, createPool, wrap }) => {
  const dsn = `${name}://user:pass@localhost:3306/db`;
  function pool(comment: unknown, failVersion = false) {
    const result = {
      query: vi.fn(async (sql: string) => {
        if (sql === VERSION_COMMENT_QUERY) {
          if (comment instanceof Error) throw comment;
          return wrap([{ version_comment: comment }]);
        }
        if (failVersion) throw new Error("connect failed");
        return wrap([{ version: "5.7.99" }]);
      }),
      end: vi.fn(),
      on: vi.fn(),
    };
    createPool.mockReturnValue(result);
    return result;
  }
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["Doris version doris-4.0.8", true],
    ["  dOrIs version 4.0", true],
    ["MySQL Community Server", false],
    ["MariaDB Server", false],
    ["Other", false],
    [undefined, false],
    [new Error("unknown variable"), false],
  ])("routes comment %s with one connect probe and no health probes", async (comment, doris) => {
    const fake = pool(comment);
    const connector = new Connector();
    await connector.connect(dsn);
    expect(fake.query.mock.calls.filter(([sql]) => sql === VERSION_COMMENT_QUERY)).toHaveLength(1);
    const callsAtConnect = fake.query.mock.calls.length;
    const selected = doris ? getDorisHealthCheck : getMySQLFamilyHealthCheck;
    const other = doris ? getMySQLFamilyHealthCheck : getDorisHealthCheck;
    await connector.getHealthCheck();
    await connector.getHealthCheck();
    expect(selected).toHaveBeenCalledTimes(2);
    expect(selected).toHaveBeenCalledWith(expect.any(Function));
    expect(other).not.toHaveBeenCalled();
    expect(fake.query).toHaveBeenCalledTimes(callsAtConnect);
    await connector.disconnect();
    await expect(connector.getHealthCheck()).rejects.toThrow("Not connected");
  });

  it("redetects on reconnect and keeps clones independent", async () => {
    pool("Doris version 4.0");
    const connector = new Connector();
    await connector.connect(dsn);
    await connector.getHealthCheck();
    const clone = connector.clone();
    await expect(clone.getHealthCheck!()).rejects.toThrow("Not connected");
    pool(undefined);
    await clone.connect(dsn);
    await clone.getHealthCheck!();
    await connector.disconnect();
    pool(undefined);
    await connector.connect(dsn);
    await connector.getHealthCheck();
    expect(getDorisHealthCheck).toHaveBeenCalledTimes(1);
    expect(getMySQLFamilyHealthCheck).toHaveBeenCalledTimes(2);
  });

  it("resets detection after a failed reconnect", async () => {
    pool("Doris version 4.0");
    const connector = new Connector();
    await connector.connect(dsn);
    pool(undefined, true);
    await expect(connector.connect(dsn)).rejects.toThrow("connect failed");
    await expect(connector.getHealthCheck()).rejects.toThrow("Not connected");
    // Also assert the failure lifecycle clears cached detection before another connect.
    expect((connector as any).isDoris).toBe(false);
    pool(undefined);
    await connector.connect(dsn);
    await connector.getHealthCheck();
    expect(getMySQLFamilyHealthCheck).toHaveBeenCalledTimes(1);
    expect(getDorisHealthCheck).not.toHaveBeenCalled();
  });
});
