import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { startConfigWatcher } from "../config-watcher.js";
import type { ConnectorManager } from "../../connectors/manager.js";

// Mock dependencies
vi.mock("fs");
vi.mock("../../config/toml-loader.js", () => ({
  resolveTomlConfigPath: vi.fn(),
  loadTomlConfig: vi.fn(),
}));
vi.mock("../../tools/registry.js", () => ({
  initializeToolRegistry: vi.fn(),
}));

import { resolveTomlConfigPath, loadTomlConfig } from "../../config/toml-loader.js";
import { initializeToolRegistry } from "../../tools/registry.js";

function createMockManager(overrides: Partial<Record<string, any>> = {}) {
  return {
    disconnect: vi.fn().mockResolvedValue(undefined),
    connectWithSources: vi.fn().mockResolvedValue(undefined),
    getAllSourceConfigs: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as ConnectorManager;
}

describe("startConfigWatcher", () => {
  let mockWatcher: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
  let watchCallback: (eventType: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWatcher = {
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
      unref: vi.fn(),
    };
    vi.mocked(fs.watch).mockImplementation((_path: any, cb: any) => {
      watchCallback = cb;
      return mockWatcher as any;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should return null when no TOML config path exists", () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue(null);
    const cleanup = startConfigWatcher(createMockManager());

    expect(cleanup).toBeNull();
    expect(fs.watch).not.toHaveBeenCalled();
  });

  it("should start watching when TOML config exists", () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const cleanup = startConfigWatcher(createMockManager());

    expect(cleanup).toBeTypeOf("function");
    expect(fs.watch).toHaveBeenCalledWith("/path/to/dbhub.toml", expect.any(Function));
    expect(mockWatcher.unref).toHaveBeenCalled();
  });

  it("should reload config on file change after debounce", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const newConfig = {
      sources: [{ id: "new_db", type: "postgres" as const, dsn: "postgres://localhost/new" }],
      tools: [],
      source: "dbhub.toml",
    };
    vi.mocked(loadTomlConfig).mockReturnValue(newConfig);
    const mockManager = createMockManager();

    startConfigWatcher(mockManager);
    watchCallback("change");

    // Before debounce, nothing should happen
    expect(mockManager.disconnect).not.toHaveBeenCalled();

    // After debounce
    await vi.advanceTimersByTimeAsync(500);

    expect(loadTomlConfig).toHaveBeenCalled();
    expect(mockManager.disconnect).toHaveBeenCalled();
    expect(mockManager.connectWithSources).toHaveBeenCalledWith(newConfig.sources);
    expect(initializeToolRegistry).toHaveBeenCalledWith({
      sources: newConfig.sources,
      tools: newConfig.tools,
    });
  });

  it("should reload on rename events (atomic editor writes)", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue({
      sources: [{ id: "db", type: "sqlite" as const, dsn: "sqlite:///:memory:" }],
      tools: [],
      source: "dbhub.toml",
    });
    const mockManager = createMockManager();

    startConfigWatcher(mockManager);
    watchCallback("rename");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.disconnect).toHaveBeenCalled();
  });

  it("should debounce rapid file changes", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue({
      sources: [{ id: "db", type: "sqlite" as const, dsn: "sqlite:///:memory:" }],
      tools: [],
      source: "dbhub.toml",
    });
    const mockManager = createMockManager();

    startConfigWatcher(mockManager);
    watchCallback("change");
    watchCallback("change");
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.disconnect).toHaveBeenCalledTimes(1);
  });

  it("should keep existing connections when new config is invalid", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockImplementation(() => {
      throw new Error("Invalid TOML");
    });
    const mockManager = createMockManager();

    startConfigWatcher(mockManager);
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.disconnect).not.toHaveBeenCalled();
  });

  it("should keep existing connections when loadTomlConfig returns null", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue(null);
    const mockManager = createMockManager();

    startConfigWatcher(mockManager);
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.disconnect).not.toHaveBeenCalled();
  });

  it("should rollback to old config (sources + tools) when connectWithSources fails", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const newConfig = {
      sources: [{ id: "bad_db", type: "postgres" as const, dsn: "postgres://localhost/bad" }],
      tools: [{ name: "execute_sql" as const, source: "bad_db", readonly: true }],
      source: "dbhub.toml",
    };
    vi.mocked(loadTomlConfig).mockReturnValue(newConfig);

    const oldSources = [{ id: "old_db", type: "sqlite" as const, dsn: "sqlite:///:memory:" }];
    const mockManager = createMockManager({
      connectWithSources: vi.fn()
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce(undefined),
      getAllSourceConfigs: vi.fn().mockReturnValue(oldSources),
    });

    startConfigWatcher(mockManager);
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    // Should have attempted new config, then rolled back to old
    expect(mockManager.connectWithSources).toHaveBeenCalledTimes(2);
    expect(mockManager.connectWithSources).toHaveBeenNthCalledWith(1, newConfig.sources);
    expect(mockManager.connectWithSources).toHaveBeenNthCalledWith(2, oldSources);
    // Rollback should restore tools too (undefined for initial config)
    expect(initializeToolRegistry).toHaveBeenLastCalledWith({ sources: oldSources, tools: undefined });
  });

  it("should not drop file changes that arrive during reload", async () => {
    vi.useRealTimers(); // Use real timers for this async-heavy test
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");

    let loadCount = 0;
    vi.mocked(loadTomlConfig).mockImplementation(() => {
      loadCount++;
      return {
        sources: [{ id: `db_${loadCount}`, type: "sqlite" as const, dsn: "sqlite:///:memory:" }],
        tools: [],
        source: "dbhub.toml",
      };
    });

    // First disconnect blocks until we resolve it
    let resolveDisconnect!: () => void;
    const mockManager = createMockManager({
      disconnect: vi.fn()
        .mockImplementationOnce(() => new Promise<void>(r => { resolveDisconnect = r; }))
        .mockResolvedValue(undefined),
    });

    startConfigWatcher(mockManager);

    // Trigger first change — after DEBOUNCE_MS, reload starts and blocks on disconnect
    watchCallback("change");
    await new Promise(r => setTimeout(r, 600));

    // Reload is in progress. Fire another change — it should set reloadPending
    watchCallback("change");
    await new Promise(r => setTimeout(r, 600));

    // Now unblock the first disconnect
    resolveDisconnect();

    // Wait for both reloads to complete
    await new Promise(r => setTimeout(r, 1200));

    // Config should have been loaded at least twice
    expect(loadCount).toBeGreaterThanOrEqual(2);
  });

  it("should clean up watcher on cleanup call", () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const cleanup = startConfigWatcher(createMockManager());
    cleanup!();

    expect(mockWatcher.close).toHaveBeenCalled();
  });
});
