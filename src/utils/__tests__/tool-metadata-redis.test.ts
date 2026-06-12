import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorManager } from "../../connectors/manager.js";
import { getToolRegistry } from "../../tools/registry.js";
import { getExecuteSqlMetadata } from "../tool-metadata.js";

vi.mock("../../connectors/manager.js");
vi.mock("../../tools/registry.js");

describe("Redis execute tool metadata", () => {
  beforeEach(() => {
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue([
      "TEST-epoch-universe-store",
      "app-postgres",
    ]);
    vi.mocked(ConnectorManager.getSourceConfig).mockImplementation((sourceId: string) => ({
      id: sourceId,
      type: sourceId === "TEST-epoch-universe-store" ? "redis" : "postgres",
      description: sourceId === "TEST-epoch-universe-store" ? "Shared test cache" : undefined,
    }) as any);
    vi.mocked(getToolRegistry).mockReturnValue({
      getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true }),
    } as any);
  });

  it("uses execute_redis name and command parameter for Redis sources", () => {
    const metadata = getExecuteSqlMetadata("TEST-epoch-universe-store");

    expect(metadata.name).toBe("execute_redis_TEST_epoch_universe_store");
    expect(Object.keys(metadata.schema)).toEqual(["command"]);
    expect(metadata.description).toContain("Execute Redis commands");
    expect(metadata.description).toContain("[READ-ONLY MODE]");
    expect(metadata.annotations.title).toContain("Execute Redis Commands");
  });
});
