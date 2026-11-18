import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHealthCheckToolHandler } from "../health-check.js";
import { ConnectorManager } from "../../connectors/manager.js";
import type { HealthCheckResult } from "../../connectors/interface.js";
import { createMockConnector, describeRequestTracking, parseToolResponse } from "./helpers.js";

vi.mock("../../connectors/manager.js");

describe("health-check tool", () => {
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);

  // Bind the mocked manager to a postgres connector reporting `health`
  const useHealthCheck = (health: HealthCheckResult, sourceId: string = "test_source") => {
    mockGetCurrentConnector.mockReturnValue(
      createMockConnector("postgres", sourceId, { getHealthCheck: vi.fn().mockResolvedValue(health) })
    );
  };

  beforeEach(() => {
    // Single-source by default, so resolveTrackedToolName resolves to the
    // bare tool name; multi-source naming is covered separately below.
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(["test_source"]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns connections and buffer_cache in snake_case", async () => {
    useHealthCheck({
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
    });

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
    mockGetCurrentConnector.mockReturnValue(createMockConnector("sqlite", "test_source"));

    const handler = createHealthCheckToolHandler("test_source");
    const result = await handler({}, null);

    expect(result.isError).toBe(true);
    const parsed = parseToolResponse(result);
    expect(parsed.code).toBe("UNSUPPORTED");
  });

  describeRequestTracking("health_check", async (sourceId) => {
    useHealthCheck({} as HealthCheckResult, sourceId);
    await createHealthCheckToolHandler(sourceId)({}, null);
  });
});
