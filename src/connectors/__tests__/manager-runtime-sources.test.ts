import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConnectorManager } from "../manager.js";
import "../sqlite/index.js";

const memory = (id: string, lazy = false) => ({ id, type: "sqlite" as const, dsn: "sqlite:///:memory:", lazy });

describe("ConnectorManager runtime sources", () => {
  let manager: ConnectorManager;

  beforeEach(async () => {
    manager = new ConnectorManager();
    await manager.connectWithSources([memory("base")]);
  });

  afterEach(async () => {
    await manager.disconnect();
  });

  it("adds an eager source and leaves the existing one connected", async () => {
    await manager.addSource(memory("extra"));

    expect(manager.getSourceIds()).toEqual(["base", "extra"]);
    expect(manager.hasSource("extra")).toBe(true);
    const result = await manager.getConnector("extra").executeSQL("SELECT 1 AS one", {});
    expect(Number(result.resultSets[0].rows[0].one)).toBe(1);
    const base = await manager.getConnector("base").executeSQL("SELECT 2 AS two", {});
    expect(Number(base.resultSets[0].rows[0].two)).toBe(2);
  });

  it("registers a lazy source without connecting until first use", async () => {
    await manager.addSource(memory("later", true));

    expect(manager.hasSource("later")).toBe(true);
    expect(() => manager.getConnector("later")).toThrow(/not found/);
    await manager.ensureConnected("later");
    const result = await manager.getConnector("later").executeSQL("SELECT 3 AS three", {});
    expect(Number(result.resultSets[0].rows[0].three)).toBe(3);
  });

  it("removes only the named source", async () => {
    await manager.addSource(memory("extra"));

    expect(await manager.removeSource("extra")).toBe(true);
    expect(manager.getSourceIds()).toEqual(["base"]);
    expect(manager.hasSource("extra")).toBe(false);
    expect(manager.getSourceConfig("extra")).toBeNull();
    const base = await manager.getConnector("base").executeSQL("SELECT 4 AS four", {});
    expect(Number(base.resultSets[0].rows[0].four)).toBe(4);
  });

  it("reports false for an unknown id", async () => {
    expect(await manager.removeSource("nope")).toBe(false);
    expect(manager.getSourceIds()).toEqual(["base"]);
  });

  it("replaces a source with the same id in place", async () => {
    await manager.addSource({ ...memory("extra"), description: "first" });
    await manager.addSource({ ...memory("extra"), description: "second" });

    expect(manager.getSourceIds()).toEqual(["base", "extra"]);
    expect(manager.getSourceConfig("extra")?.description).toBe("second");
    const result = await manager.getConnector("extra").executeSQL("SELECT 5 AS five", {});
    expect(Number(result.resultSets[0].rows[0].five)).toBe(5);
  });

  it("removes a lazy source that never connected", async () => {
    await manager.addSource(memory("later", true));

    expect(await manager.removeSource("later")).toBe(true);
    expect(manager.hasSource("later")).toBe(false);
    await expect(manager.ensureConnected("later")).rejects.toThrow(/not found/);
  });
});
