import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { startConfigWatcher, applySourceDiff, sourceConfigEquals, selectTools } from "../config-watcher.js";
import type { ConnectorManager } from "../../connectors/manager.js";

// Mock dependencies
vi.mock("fs");
vi.mock("../../config/toml-loader.js", () => ({
  resolveTomlConfigPath: vi.fn(),
  loadTomlConfig: vi.fn(),
}));
vi.mock("../../tools/registry.js", () => ({
  initializeToolRegistry: vi.fn(),
  ToolRegistry: vi.fn(),
}));

import { resolveTomlConfigPath, loadTomlConfig } from "../../config/toml-loader.js";
import { initializeToolRegistry, ToolRegistry } from "../../tools/registry.js";

function createMockManager(overrides: Partial<Record<string, any>> = {}) {
  return {
    addSource: vi.fn().mockResolvedValue(undefined),
    removeSource: vi.fn().mockResolvedValue(undefined),
    reorderSources: vi.fn(),
    getAllSourceConfigs: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as ConnectorManager;
}

function createOptions(connectorManager: ConnectorManager, initialTools?: any[]) {
  return { connectorManager, initialTools };
}

const dbA = { id: "a", type: "sqlite" as const, dsn: "sqlite:///:memory:" };
const dbB = { id: "b", type: "postgres" as const, dsn: "postgres://localhost/b" };

describe("sourceConfigEquals", () => {
  it("ignores key order and undefined fields", () => {
    expect(sourceConfigEquals(
      { id: "x", type: "postgres", dsn: "postgres://h/d", lazy: undefined },
      { type: "postgres", id: "x", dsn: "postgres://h/d" },
    )).toBe(true);
  });

  it("detects a changed field", () => {
    expect(sourceConfigEquals(
      { id: "x", type: "postgres", dsn: "postgres://h/d" },
      { id: "x", type: "postgres", dsn: "postgres://h/d", query_timeout: 5 },
    )).toBe(false);
  });
});

describe("applySourceDiff", () => {
  it("leaves unchanged sources alone, adds new ones and removes dropped ones", async () => {
    const manager = createMockManager();
    const dbC = { id: "c", type: "mysql" as const, dsn: "mysql://localhost/c" };

    const { sources: applied, rolledBack } = await applySourceDiff(manager, [dbA, dbB], [dbA, dbC]);

    expect(manager.removeSource).toHaveBeenCalledTimes(1);
    expect(manager.removeSource).toHaveBeenCalledWith("b");
    expect(manager.addSource).toHaveBeenCalledTimes(1);
    expect(manager.addSource).toHaveBeenCalledWith(dbC);
    expect(manager.reorderSources).toHaveBeenCalledWith(["a", "c"]);
    expect(applied).toEqual([dbA, dbC]);
    expect(rolledBack.size).toBe(0);
  });

  it("reconnects only a source whose config changed", async () => {
    const manager = createMockManager();
    const changedB = { ...dbB, query_timeout: 10 };

    const { sources: applied } = await applySourceDiff(manager, [dbA, dbB], [dbA, changedB]);

    expect(manager.removeSource).toHaveBeenCalledTimes(1);
    expect(manager.removeSource).toHaveBeenCalledWith("b");
    expect(manager.addSource).toHaveBeenCalledTimes(1);
    expect(manager.addSource).toHaveBeenCalledWith(changedB);
    expect(applied).toEqual([dbA, changedB]);
  });

  it("rolls back only the changed source when its new config fails to connect", async () => {
    const changedB = { ...dbB, dsn: "postgres://unreachable/b" };
    const manager = createMockManager({
      addSource: vi.fn()
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce(undefined),
    });

    const { sources: applied, rolledBack } = await applySourceDiff(manager, [dbA, dbB], [dbA, changedB]);

    expect(manager.removeSource).toHaveBeenCalledTimes(1);
    expect(manager.addSource).toHaveBeenNthCalledWith(1, changedB);
    expect(manager.addSource).toHaveBeenNthCalledWith(2, dbB);
    expect(applied).toEqual([dbA, dbB]);
    expect([...rolledBack]).toEqual(["b"]);
  });

  it("skips a new source that fails to connect and keeps the rest", async () => {
    const manager = createMockManager({
      addSource: vi.fn().mockRejectedValue(new Error("Connection refused")),
    });

    const { sources: applied, rolledBack } = await applySourceDiff(manager, [dbA], [dbA, dbB]);

    expect(manager.removeSource).not.toHaveBeenCalled();
    expect(applied).toEqual([dbA]);
    expect(rolledBack.size).toBe(0);
  });

  it("reorders sources so the file's first entry stays the default", async () => {
    const manager = createMockManager();

    const { sources: applied } = await applySourceDiff(manager, [dbA, dbB], [dbB, dbA]);

    expect(manager.removeSource).not.toHaveBeenCalled();
    expect(manager.addSource).not.toHaveBeenCalled();
    expect(manager.reorderSources).toHaveBeenCalledWith(["b", "a"]);
    expect(applied).toEqual([dbB, dbA]);
  });
});

describe("selectTools", () => {
  const toolA = { name: "execute_sql" as const, source: "a" };
  const oldToolB = { name: "execute_sql" as const, source: "b", readonly: true };
  const newToolB = { name: "execute_sql" as const, source: "b", readonly: false };
  const toolC = { name: "execute_sql" as const, source: "c" };

  it("uses the new file's tools for live sources and drops tools of sources that are not live", () => {
    expect(selectTools([dbA], new Set(), [toolA, newToolB], [toolA, oldToolB])).toEqual([toolA]);
  });

  it("keeps the previous tools for a source that was rolled back", () => {
    expect(selectTools([dbA, dbB], new Set(["b"]), [toolA, newToolB], [toolA, oldToolB]))
      .toEqual([toolA, oldToolB]);
  });

  it("applies new tools to an unchanged source", () => {
    expect(selectTools([dbA, dbB], new Set(), [toolA, newToolB], [toolA, oldToolB]))
      .toEqual([toolA, newToolB]);
  });

  it("drops a rolled-back source's new tools even when it had none before", () => {
    expect(selectTools([dbB], new Set(["b"]), [newToolB, toolC], [])).toEqual([]);
  });

  it("returns undefined when neither config declares tools", () => {
    expect(selectTools([dbA], new Set(), undefined, undefined)).toBeUndefined();
  });
});

describe("startConfigWatcher", () => {
  let mockWatcher: { on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
  let watchCallback: (eventType: string) => void;

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

  it("should apply the diff and rebuild the tool registry after debounce", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const newConfig = {
      sources: [dbA, dbB],
      tools: [{ name: "execute_sql" as const, source: "b", readonly: true }],
      source: "dbhub.toml",
    };
    vi.mocked(loadTomlConfig).mockReturnValue(newConfig);
    const mockManager = createMockManager({
      getAllSourceConfigs: vi.fn().mockReturnValue([dbA]),
    });

    startConfigWatcher(createOptions(mockManager));
    watchCallback("change");

    // Before debounce, nothing should happen
    expect(mockManager.addSource).not.toHaveBeenCalled();

    // After debounce
    await vi.advanceTimersByTimeAsync(500);

    expect(loadTomlConfig).toHaveBeenCalled();
    expect(mockManager.removeSource).not.toHaveBeenCalled();
    expect(mockManager.addSource).toHaveBeenCalledTimes(1);
    expect(mockManager.addSource).toHaveBeenCalledWith(dbB);
    expect(initializeToolRegistry).toHaveBeenCalledWith({
      sources: newConfig.sources,
      tools: newConfig.tools,
    });
  });

  it("should diff successive reloads against the last applied config", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const mockManager = createMockManager({
      getAllSourceConfigs: vi.fn().mockReturnValue([dbA]),
    });
    startConfigWatcher(createOptions(mockManager));

    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [dbA, dbB], tools: [], source: "dbhub.toml" });
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [dbB], tools: [], source: "dbhub.toml" });
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.addSource).toHaveBeenCalledTimes(1);
    expect(mockManager.addSource).toHaveBeenCalledWith(dbB);
    expect(mockManager.removeSource).toHaveBeenCalledTimes(1);
    expect(mockManager.removeSource).toHaveBeenCalledWith("a");
  });

  it("should drop tools that reference a source that failed to connect", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue({
      sources: [dbA, dbB],
      tools: [
        { name: "execute_sql" as const, source: "a" },
        { name: "execute_sql" as const, source: "b", readonly: true },
      ],
      source: "dbhub.toml",
    });
    const mockManager = createMockManager({
      addSource: vi.fn().mockRejectedValue(new Error("Connection refused")),
      getAllSourceConfigs: vi.fn().mockReturnValue([dbA]),
    });

    startConfigWatcher(createOptions(mockManager));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(initializeToolRegistry).toHaveBeenCalledWith({
      sources: [dbA],
      tools: [{ name: "execute_sql", source: "a" }],
    });
  });

  it("should keep a rolled-back source's previous tools instead of the new file's", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const changedB = { ...dbB, dsn: "postgres://unreachable/b" };
    const oldTools = [{ name: "execute_sql" as const, source: "b", readonly: true }];
    vi.mocked(loadTomlConfig).mockReturnValue({
      sources: [dbA, changedB],
      tools: [{ name: "execute_sql" as const, source: "b", readonly: false }],
      source: "dbhub.toml",
    });
    const mockManager = createMockManager({
      addSource: vi.fn()
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce(undefined),
      getAllSourceConfigs: vi.fn().mockReturnValue([dbA, dbB]),
    });

    startConfigWatcher(createOptions(mockManager, oldTools));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(initializeToolRegistry).toHaveBeenCalledWith({ sources: [dbA, dbB], tools: oldTools });
  });

  it("should touch nothing when the new file fails registry validation", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue({
      sources: [dbA, dbB],
      tools: [{ name: "bad_tool", source: "b", description: "x", statement: "SELECT 1", parameters: [{} as any] }],
      source: "dbhub.toml",
    });
    vi.mocked(ToolRegistry).mockImplementationOnce(() => {
      throw new Error("Tool 'bad_tool' has parameter missing 'name' field");
    });
    const mockManager = createMockManager({
      getAllSourceConfigs: vi.fn().mockReturnValue([dbA]),
    });

    startConfigWatcher(createOptions(mockManager));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(ToolRegistry).toHaveBeenCalledTimes(1);
    expect(mockManager.addSource).not.toHaveBeenCalled();
    expect(mockManager.removeSource).not.toHaveBeenCalled();
    expect(initializeToolRegistry).not.toHaveBeenCalled();
  });

  it("should take a rolled-back source offline when its previous tools conflict with the new file", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const changedB = { ...dbB, dsn: "postgres://unreachable/b" };
    const oldTools = [{ name: "report", source: "b", description: "x", statement: "SELECT 1" }];
    const newTools = [{ name: "report", source: "a", description: "x", statement: "SELECT 2" }];
    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [dbA, changedB], tools: newTools, source: "dbhub.toml" });
    vi.mocked(initializeToolRegistry)
      .mockImplementationOnce(() => { throw new Error("Duplicate tool name 'report'"); })
      .mockImplementationOnce(() => undefined);
    const mockManager = createMockManager({
      addSource: vi.fn()
        .mockRejectedValueOnce(new Error("Connection refused"))
        .mockResolvedValueOnce(undefined),
      getAllSourceConfigs: vi.fn().mockReturnValue([dbA, dbB]),
    });

    startConfigWatcher(createOptions(mockManager, oldTools));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    // First attempt mixed b's old tool with a's new one and failed; b was then removed.
    expect(initializeToolRegistry).toHaveBeenNthCalledWith(1, { sources: [dbA, dbB], tools: [...newTools, ...oldTools] });
    expect(mockManager.removeSource).toHaveBeenLastCalledWith("b");
    expect(initializeToolRegistry).toHaveBeenNthCalledWith(2, { sources: [dbA], tools: newTools });

    // The next reload diffs against the state actually committed: only a is live.
    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [dbA, dbB], tools: [], source: "dbhub.toml" });
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);
    expect(mockManager.addSource).toHaveBeenLastCalledWith(dbB);
  });

  it("should debounce rapid file changes", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue({ sources: [dbA], tools: [], source: "dbhub.toml" });
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
    const mockManager = createMockManager({
      getAllSourceConfigs: vi.fn().mockReturnValue([dbA]),
    });

    startConfigWatcher(createOptions(mockManager));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.removeSource).not.toHaveBeenCalled();
    expect(mockManager.addSource).not.toHaveBeenCalled();
    expect(initializeToolRegistry).not.toHaveBeenCalled();
  });

  it("should keep existing connections when loadTomlConfig returns null", async () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    vi.mocked(loadTomlConfig).mockReturnValue(null);
    const mockManager = createMockManager();

    startConfigWatcher(createOptions(mockManager));
    watchCallback("change");
    await vi.advanceTimersByTimeAsync(500);

    expect(mockManager.removeSource).not.toHaveBeenCalled();
    expect(mockManager.addSource).not.toHaveBeenCalled();
  });

  it("should clean up watcher on cleanup call", () => {
    vi.mocked(resolveTomlConfigPath).mockReturnValue("/path/to/dbhub.toml");
    const cleanup = startConfigWatcher(createOptions(createMockManager()));
    cleanup!();

    expect(mockWatcher.close).toHaveBeenCalled();
  });
});
