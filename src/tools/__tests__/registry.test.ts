import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../registry.js";
import { ALL_BUILTIN_TOOL_NAMES } from "../builtin-tools.js";
import type { TomlConfig, ToolConfig } from "../../types/config.js";

vi.mock("../../connectors/manager.js");

const sources: TomlConfig["sources"] = [{ id: "db1", type: "postgres" } as any];

describe("ToolRegistry", () => {
  it("defaults a source with no [[tools]] entries to execute_sql + search_objects only", () => {
    const registry = new ToolRegistry({ sources });

    expect(registry.getEnabledToolConfigs("db1").map((t) => t.name)).toEqual(["execute_sql", "search_objects"]);
  });

  it.each(["explain_sql", "health_check"] as const)("enables %s only when explicitly configured", (name) => {
    const registry = new ToolRegistry({
      sources,
      tools: [
        { name: "execute_sql", source: "db1" },
        { name, source: "db1" } as ToolConfig,
      ],
    });

    expect(registry.getEnabledToolConfigs("db1").map((t) => t.name)).toEqual(["execute_sql", name]);
    expect(registry.getBuiltinToolConfig(name, "db1")).toMatchObject({ name, source: "db1" });
  });

  it.each([...ALL_BUILTIN_TOOL_NAMES])(
    "rejects a custom tool whose name collides with the %s naming pattern",
    (name) => {
      const tools: TomlConfig["tools"] = [
        {
          name: `${name}_extra`,
          source: "db1",
          description: `Custom tool colliding with ${name}`,
          statement: "SELECT 1",
        } as any,
      ];

      expect(() => new ToolRegistry({ sources, tools })).toThrow("conflicts with built-in tool naming pattern");
    }
  );
});
