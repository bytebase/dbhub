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

describe("startConfigWatcher", () => {
  let mockWatcher: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let watchCallback: (eventType: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWatcher = {
      on: vi.fn().mockReturnThis(),
      close: vi.fn(),
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
    const mockManager = {} as ConnectorManager;

    const cleanup = startConfigWatcher(mockManager);

    expect(cleanup).toBeNull();
    expect(fs.watch).not.toHaveBeenCalled();
  });

  it("should start watching when TOML config exists", () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const mockManager = {} as ConnectorManager;

    const cleanup = startConfigWatcher(mockManager);

    expect(cleanup).toBeTypeOf("function");
    expect(fs.watch).toHaveBeenCalledWith("/path/to/dbhub.toml", expect.any(Function));
  });

  it("should reload config on file change after debounce", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const newConfig = {
      sources: [{ id: "new_db", type: "postgres" as const, dsn: "postgres://localhost/new" }],
      tools: [],
      source: "dbhub.toml",
    };
    vi.mocked(loadTomlConfig).mockReturnValue(newConfig);

    const mockManager = {
      disconnect: vi.fn().mockResolvedValue(undefined),
      connectWithSources: vi.fn().mockResolvedValue(undefined),
      getAllSourceConfigs: vi.fn().mockReturnValue([]),
    } as unknown as ConnectorManager;

    startConfigWatcher(mockManager);

    // Trigger file change
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

  it("should debounce rapid file changes", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue({
      sources: [{ id: "db", type: "sqlite" as const, dsn: "sqlite:///:memory:" }],
      tools: [],
      source: "dbhub.toml",
    });

    const mockManager = {
      disconnect: vi.fn().mockResolvedValue(undefined),
      connectWithSources: vi.fn().mockResolvedValue(undefined),
      getAllSourceConfigs: vi.fn().mockReturnValue([]),
    } as unknown as ConnectorManager;

    startConfigWatcher(mockManager);

    // Trigger multiple rapid changes
    watchCallback("change");
    watchCallback("change");
    watchCallback("change");

    await vi.advanceTimersByTimeAsync(500);

    // Should only reload once
    expect(mockManager.disconnect).toHaveBeenCalledTimes(1);
  });

  it("should keep existing connections when new config is invalid", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockImplementation(() => {
      throw new Error("Invalid TOML");
    });

    const mockManager = {
      disconnect: vi.fn(),
      connectWithSources: vi.fn(),
    } as unknown as ConnectorManager;

    startConfigWatcher(mockManager);
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    // Should NOT disconnect existing connections
    expect(mockManager.disconnect).not.toHaveBeenCalled();
  });

  it("should keep existing connections when loadTomlConfig returns null", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue(null);

    const mockManager = {
      disconnect: vi.fn(),
      connectWithSources: vi.fn(),
    } as unknown as ConnectorManager;

    startConfigWatcher(mockManager);
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.disconnect).not.toHaveBeenCalled();
  });

  it("should rollback to old config when connectWithSources fails", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const newConfig = {
      sources: [{ id: "bad_db", type: "postgres" as const, dsn: "postgres://localhost/bad" }],
      tools: [],
      source: "dbhub.toml",
    };
    vi.mocked(loadTomlConfig).mockReturnValue(newConfig);

    const oldSources = [{ id: "old_db", type: "sqlite" as const, dsn: "sqlite:///:memory:" }];
    const mockManager = {
      disconnect: vi.fn().mockResolvedValue(undefined),
      connectWithSources: vi.fn()
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce(undefined),
      getAllSourceConfigs: vi.fn().mockReturnValue(oldSources),
    } as unknown as ConnectorManager;

    startConfigWatcher(mockManager);
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    // Should have attempted new config, then rolled back to old
    expect(mockManager.connectWithSources).toHaveBeenCalledTimes(2);
    expect(mockManager.connectWithSources).toHaveBeenNthCalledWith(1, newConfig.sources);
    expect(mockManager.connectWithSources).toHaveBeenNthCalledWith(2, oldSources);
    expect(initializeToolRegistry).toHaveBeenCalledWith({ sources: oldSources });
  });

  it("should clean up watcher on cleanup call", () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const mockManager = {} as ConnectorManager;

    const cleanup = startConfigWatcher(mockManager);
    cleanup!();

    expect(mockWatcher.close).toHaveBeenCalled();
  });

  it("should ignore non-change events", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const mockManager = {
      disconnect: vi.fn(),
      connectWithSources: vi.fn(),
    } as unknown as ConnectorManager;

    startConfigWatcher(mockManager);
    watchCallback("rename");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.disconnect).not.toHaveBeenCalled();
  });
});
