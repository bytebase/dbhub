import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../registry.js";
import { ConnectorManager } from "../../connectors/manager.js";
import type { TomlConfig } from "../../types/config.js";

vi.mock("../../connectors/manager.js");

describe("ToolRegistry", () => {
  it("defaults a source with no [[tools]] entries to execute_sql + search_objects only", () => {
    const config: TomlConfig = {
      sources: [{ id: "db1", type: "postgres" } as any],
    };
    const registry = new ToolRegistry(config);

    const enabled = registry.getEnabledToolConfigs("db1").map((t) => t.name);
    expect(enabled).toEqual(["execute_sql", "search_objects"]);
    expect(enabled).not.toContain("explain_sql");
  });

  it("enables explain_sql only when explicitly configured", () => {
    const config: TomlConfig = {
      sources: [{ id: "db1", type: "postgres" } as any],
      tools: [
        { name: "execute_sql", source: "db1" },
        { name: "explain_sql", source: "db1" },
      ],
    };
    const registry = new ToolRegistry(config);

    const enabled = registry.getEnabledToolConfigs("db1").map((t) => t.name);
    expect(enabled).toEqual(["execute_sql", "explain_sql"]);
    expect(registry.getBuiltinToolConfig("explain_sql", "db1")).toMatchObject({
      name: "explain_sql",
      source: "db1",
    });
  });

  it("rejects a custom tool whose name collides with the explain_sql naming pattern", () => {
    vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ id: "db1", type: "postgres" } as any);
    const config: TomlConfig = {
      sources: [{ id: "db1", type: "postgres" } as any],
      tools: [
        {
          name: "explain_sql_extra",
          source: "db1",
          description: "Custom tool colliding with explain_sql",
          statement: "SELECT 1",
        } as any,
      ],
    };

    expect(() => new ToolRegistry(config)).toThrow(
      "conflicts with built-in tool naming pattern"
    );
  });

  it("enables health_check only when explicitly configured", () => {
    const config: TomlConfig = {
      sources: [{ id: "db1", type: "postgres" } as any],
      tools: [
        { name: "execute_sql", source: "db1" },
        { name: "health_check", source: "db1" },
      ],
    };
    const registry = new ToolRegistry(config);

    const enabled = registry.getEnabledToolConfigs("db1").map((t) => t.name);
    expect(enabled).toEqual(["execute_sql", "health_check"]);
    expect(registry.getBuiltinToolConfig("health_check", "db1")).toMatchObject({
      name: "health_check",
      source: "db1",
    });
  });

  it("rejects a custom tool whose name collides with the health_check naming pattern", () => {
    vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ id: "db1", type: "postgres" } as any);
    const config: TomlConfig = {
      sources: [{ id: "db1", type: "postgres" } as any],
      tools: [
        {
          name: "health_check_extra",
          source: "db1",
          description: "Custom tool colliding with health_check",
          statement: "SELECT 1",
        } as any,
      ],
    };

    expect(() => new ToolRegistry(config)).toThrow(
      "conflicts with built-in tool naming pattern"
    );
  });
});
