import { describe, it, expect, vi, afterEach } from "vitest";
import { createHealthCheckToolHandler } from "../health-check.js";
import { ConnectorManager } from "../../connectors/manager.js";
import type { Connector, ConnectorType, HealthCheckResult } from "../../connectors/interface.js";
import { getDorisHealthCheck } from "../../connectors/doris-health-check.js";

vi.mock("../../connectors/manager.js");

const createMockConnector = (
  id: ConnectorType = "postgres",
  sourceId: string = "default",
  withHealthCheck = true
): Connector => ({
  id,
  name: "Mock Connector",
  getId: () => sourceId,
  dsnParser: {} as any,
  connect: vi.fn(),
  disconnect: vi.fn(),
  clone: vi.fn(),
  getSchemas: vi.fn(),
  getTables: vi.fn(),
  tableExists: vi.fn(),
  getTableSchema: vi.fn(),
  getTableIndexes: vi.fn(),
  getStoredProcedures: vi.fn(),
  getStoredProcedureDetail: vi.fn(),
  executeSQL: vi.fn(),
  ...(withHealthCheck ? { getHealthCheck: vi.fn() } : {}),
});

const parseToolResponse = (response: any) => JSON.parse(response.content[0].text);

describe("health-check tool", () => {
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns connections and buffer_cache in snake_case", async () => {
    const mockConnector = createMockConnector("postgres", "test_source");
    mockGetCurrentConnector.mockReturnValue(mockConnector);
    const health: HealthCheckResult = {
      connections: {
        total: 10,
        active: 2,
        idle: 7,
        idleInTransaction: 1,
        idleInTransactionAborted: 0,
        maxConnections: 100,
        longestIdleInTransactionSeconds: 12.5,
        longestActiveQuerySeconds: null,
      },
      bufferCache: {
        hitRatioPct: 99.1,
        blocksHit: 1000,
        blocksRead: 9,
      },
    };
    vi.mocked(mockConnector.getHealthCheck!).mockResolvedValue(health);

    const handler = createHealthCheckToolHandler("test_source");
    const result = await handler({}, null);
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      source_id: "test_source",
      connections: {
        total: 10,
        active: 2,
        idle: 7,
        idle_in_transaction: 1,
        idle_in_transaction_aborted: 0,
        max_connections: 100,
        longest_idle_in_transaction_seconds: 12.5,
        longest_active_query_seconds: null,
      },
      buffer_cache: {
        hit_ratio_pct: 99.1,
        blocks_hit: 1000,
        blocks_read: 9,
      },
    });
  });

  it("returns UNSUPPORTED when the connector has no getHealthCheck implementation", async () => {
    const mockConnector = createMockConnector("sqlite", "test_source", false);
    mockGetCurrentConnector.mockReturnValue(mockConnector);

    const handler = createHealthCheckToolHandler("test_source");
    const result = await handler({}, null);

    expect(result.isError).toBe(true);
    const parsed = parseToolResponse(result);
    expect(parsed.code).toBe("UNSUPPORTED");
  });

  it("serializes native Doris nodes and unsupported metrics using shared JSON rules", async () => {
    const connector = createMockConnector("mysql", "doris");
    mockGetCurrentConnector.mockReturnValue(connector);
    connector.getHealthCheck = () =>
      getDorisHealthCheck(async (sql) => {
        if (sql === "SHOW FRONTENDS") return [{ Name: "fe", Alive: "false", SmallId: 42n }];
        if (sql === "SHOW BACKENDS")
          return [{ BackendId: 9007199254740993n, TotalCapacity: "1.000 B" }];
        return [{ total: "3", active: "1", idle: "2", longest_active_query_seconds: null }];
      });
    const parsed = parseToolResponse(await createHealthCheckToolHandler("doris")({}, null));
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      source_id: "doris",
      connections: {
        total: 3,
        active: 1,
        idle: 2,
        idle_in_transaction: null,
        max_connections: null,
        longest_idle_in_transaction_seconds: null,
        longest_active_query_seconds: null,
      },
      nodes: {
        frontends: [{ Name: "fe", Alive: "false", SmallId: 42 }],
        backends: [{ BackendId: "9007199254740993", TotalCapacity: "1.000 B" }],
      },
    });
    expect(parsed.data).not.toHaveProperty("buffer_cache");
    expect(parsed.data.notes.join(" ")).toContain("visible sessions");
  });

  it.each([
    ["PROCESSLIST", "connections"],
    ["SHOW FRONTENDS", "frontends"],
    ["SHOW BACKENDS", "backends"],
  ])("returns the Doris section label when %s fails", async (statement, section) => {
    const connector = createMockConnector("mysql", "doris");
    mockGetCurrentConnector.mockReturnValue(connector);
    connector.getHealthCheck = () =>
      getDorisHealthCheck(async (sql) => {
        if (sql.includes(statement)) throw new Error("query denied");
        return [];
      });
    const parsed = parseToolResponse(await createHealthCheckToolHandler("doris")({}, null));
    expect(parsed).toMatchObject({
      success: false,
      code: "EXECUTION_ERROR",
      error: `Doris health check ${section} failed: query denied`,
    });
  });

  it.each([
    ["mysql", { code: "ECONNRESET" }, "SOURCE_UNREACHABLE"],
    ["mysql", { code: "ER_ACCESS_DENIED_ERROR" }, "AUTH_FAILED"],
    ["mariadb", { errno: 1045 }, "AUTH_FAILED"],
    ["mysql", { code: "ECONNRESET", __dbhubSSHTunnelError: true }, "TUNNEL_FAILED"],
  ] as const)("classifies original %s Doris failures with %j", async (type, fields, code) => {
    const connector = createMockConnector(type, "doris");
    mockGetCurrentConnector.mockReturnValue(connector);
    vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ type } as any);
    connector.getHealthCheck = () =>
      getDorisHealthCheck(async (sql) => {
        if (sql === "SHOW BACKENDS") throw Object.assign(new Error("diagnostic failed"), fields);
        return [];
      });
    const parsed = parseToolResponse(await createHealthCheckToolHandler("doris")({}, null));
    expect(parsed).toMatchObject({ success: false, code, details: { source_id: "doris" } });
  });

  it("returns EXECUTION_ERROR when the connector throws", async () => {
    const mockConnector = createMockConnector("postgres", "test_source");
    mockGetCurrentConnector.mockReturnValue(mockConnector);
    vi.mocked(mockConnector.getHealthCheck!).mockRejectedValue(new Error("boom"));

    const handler = createHealthCheckToolHandler("test_source");
    const result = await handler({}, null);

    expect(result.isError).toBe(true);
    const parsed = parseToolResponse(result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("boom");
    expect(parsed.code).toBe("EXECUTION_ERROR");
  });
});
