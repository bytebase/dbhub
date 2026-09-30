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
  getToolRegistry: vi.fn(),
}));

import { resolveTomlConfigPath, loadTomlConfig } from "../../config/toml-loader.js";
import { getToolRegistry } from "../../tools/registry.js";

function createMockManager(overrides: Partial<Record<string, any>> = {}) {
  return {
    addSource: vi.fn().mockResolvedValue(undefined),
    removeSource: vi.fn().mockResolvedValue(true),
    getAllSourceConfigs: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as ConnectorManager;
}

function createOptions(connectorManager: ConnectorManager, initialTools?: any[]) {
  return { connectorManager, initialTools };
}

const OLD_DB = { id: "old_db", type: "sqlite" as const, dsn: "sqlite:///:memory:" };
const OLD_TOOLS = [{ name: "execute_sql" as const, source: "old_db" }];

describe("startConfigWatcher", () => {
  let mockWatcher: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
  let watchCallback: (eventType: string) => void;
  let registry: { setSourceTools: ReturnType<typeof vi.fn>; removeSource: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
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
    registry = { setSourceTools: vi.fn(), removeSource: vi.fn() };
    vi.mocked(getToolRegistry).mockReturnValue(registry as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should return null when no TOML config path exists", () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue(null);
    const cleanup = startConfigWatcher(createOptions(createMockManager()));

    expect(cleanup).toBeNull();
    expect(fs.watch).not.toHaveBeenCalled();
  });

  it("should start watching when TOML config exists", () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const cleanup = startConfigWatcher(createOptions(createMockManager()));

    expect(cleanup).toBeTypeOf("function");
    expect(fs.watch).toHaveBeenCalledWith("/path/to/dbhub.toml", expect.any(Function));
    expect(mockWatcher.unref).toHaveBeenCalled();
  });

  it("should add new sources on file change after debounce", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const newSource = { id: "new_db", type: "postgres" as const, dsn: "postgres://localhost/new" };
    const newTools = [{ name: "execute_sql" as const, source: "new_db", readonly: true }];
    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [newSource], tools: newTools, source: "dbhub.toml" });
    const mockManager = createMockManager();

    startConfigWatcher(createOptions(mockManager));
    watchCallback("change");

    // Before debounce, nothing should happen
    expect(mockManager.addSource).not.toHaveBeenCalled();

    // After debounce
    await vi.advanceTimersByTimeAsync(500);

    expect(loadTomlConfig).toHaveBeenCalled();
    expect(mockManager.addSource).toHaveBeenCalledWith(newSource);
    expect(registry.setSourceTools).toHaveBeenCalledWith("new_db", newTools);
    expect(mockManager.removeSource).not.toHaveBeenCalled();
  });

  it("should leave unchanged sources untouched", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const added = { id: "added_db", type: "sqlite" as const, dsn: "sqlite:///:memory:" };
    vi.mocked(loadTomlConfig).mockReturnValue({
      sources: [{ ...OLD_DB }, added],
      tools: [...OLD_TOOLS],
      source: "dbhub.toml",
    });
    const mockManager = createMockManager({ getAllSourceConfigs: vi.fn().mockReturnValue([OLD_DB]) });

    startConfigWatcher(createOptions(mockManager, OLD_TOOLS));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.addSource).toHaveBeenCalledTimes(1);
    expect(mockManager.addSource).toHaveBeenCalledWith(added);
    expect(mockManager.removeSource).not.toHaveBeenCalled();
    expect(registry.setSourceTools).not.toHaveBeenCalledWith("old_db", expect.anything());
  });

  it("should remove sources that disappeared from the file", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [], tools: [], source: "dbhub.toml" });
    const mockManager = createMockManager({ getAllSourceConfigs: vi.fn().mockReturnValue([OLD_DB]) });

    startConfigWatcher(createOptions(mockManager, OLD_TOOLS));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.removeSource).toHaveBeenCalledWith("old_db");
    expect(registry.removeSource).toHaveBeenCalledWith("old_db");
    expect(mockManager.addSource).not.toHaveBeenCalled();
  });

  it("should re-add a source whose tools changed", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const changedTools = [{ name: "execute_sql" as const, source: "old_db", readonly: true }];
    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [{ ...OLD_DB }], tools: changedTools, source: "dbhub.toml" });
    const mockManager = createMockManager({ getAllSourceConfigs: vi.fn().mockReturnValue([OLD_DB]) });

    startConfigWatcher(createOptions(mockManager, OLD_TOOLS));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.addSource).toHaveBeenCalledWith(OLD_DB);
    expect(registry.setSourceTools).toHaveBeenCalledWith("old_db", changedTools);
  });

  it("should debounce rapid file changes", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue({
      sources: [{ id: "db", type: "sqlite" as const, dsn: "sqlite:///:memory:" }],
      tools: [],
      source: "dbhub.toml",
    });
    const mockManager = createMockManager();

    startConfigWatcher(createOptions(mockManager));
    watchCallback("change");
    watchCallback("change");
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(loadTomlConfig).toHaveBeenCalledTimes(1);
    expect(mockManager.addSource).toHaveBeenCalledTimes(1);
  });

  it("should keep existing connections when new config is invalid", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockImplementation(() => {
      throw new Error("Invalid TOML");
    });
    const mockManager = createMockManager({ getAllSourceConfigs: vi.fn().mockReturnValue([OLD_DB]) });

    startConfigWatcher(createOptions(mockManager, OLD_TOOLS));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.removeSource).not.toHaveBeenCalled();
    expect(mockManager.addSource).not.toHaveBeenCalled();
  });

  it("should keep existing connections when loadTomlConfig returns null", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue(null);
    const mockManager = createMockManager({ getAllSourceConfigs: vi.fn().mockReturnValue([OLD_DB]) });

    startConfigWatcher(createOptions(mockManager, OLD_TOOLS));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.removeSource).not.toHaveBeenCalled();
    expect(mockManager.addSource).not.toHaveBeenCalled();
  });

  it("should roll a changed source back to its previous definition when the new one fails", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const badSource = { id: "old_db", type: "postgres" as const, dsn: "postgres://localhost/bad" };
    const badTools = [{ name: "execute_sql" as const, source: "old_db", readonly: true }];
    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [badSource], tools: badTools, source: "dbhub.toml" });

    const mockManager = createMockManager({
      addSource: vi.fn()
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce(undefined),
      getAllSourceConfigs: vi.fn().mockReturnValue([OLD_DB]),
    });

    startConfigWatcher(createOptions(mockManager, OLD_TOOLS));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.addSource).toHaveBeenNthCalledWith(1, badSource);
    expect(mockManager.addSource).toHaveBeenLastCalledWith(OLD_DB);
    expect(registry.setSourceTools).toHaveBeenLastCalledWith("old_db", OLD_TOOLS);
  });

  it("should drop a brand-new source that fails instead of leaving partial state", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue({
      sources: [{ ...OLD_DB }, { id: "bad", type: "postgres" as const, dsn: "postgres://localhost/bad" }],
      tools: [...OLD_TOOLS],
      source: "dbhub.toml",
    });
    const mockManager = createMockManager({
      addSource: vi.fn().mockRejectedValueOnce(new Error("Partial failure")),
      getAllSourceConfigs: vi.fn().mockReturnValue([OLD_DB]),
    });

    startConfigWatcher(createOptions(mockManager, OLD_TOOLS));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.addSource).toHaveBeenCalledTimes(1);
    expect(registry.removeSource).toHaveBeenCalledWith("bad");
    expect(mockManager.removeSource).not.toHaveBeenCalledWith("old_db");
  });

  it("should treat the effective config as the baseline for the next reload", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const added = { id: "added_db", type: "sqlite" as const, dsn: "sqlite:///:memory:" };
    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [{ ...OLD_DB }, added], tools: [...OLD_TOOLS], source: "dbhub.toml" });
    const mockManager = createMockManager({ getAllSourceConfigs: vi.fn().mockReturnValue([OLD_DB]) });

    startConfigWatcher(createOptions(mockManager, OLD_TOOLS));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(mockManager.addSource).toHaveBeenCalledTimes(1);

    // Same file again: nothing to do
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(mockManager.addSource).toHaveBeenCalledTimes(1);
    expect(mockManager.removeSource).not.toHaveBeenCalled();
  });

  it("should clean up watcher on cleanup call", () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const cleanup = startConfigWatcher(createOptions(createMockManager()));
    cleanup!();

    expect(mockWatcher.close).toHaveBeenCalled();
  });
});
