import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ConnectorManager } from "../../connectors/manager.js";
import { setupManagerWithFixture, FIXTURES, loadFixtureConfig } from "../../__fixtures__/helpers.js";
import { ALL_BUILTIN_TOOL_NAMES } from "../builtin-tools.js";
import { BUILTIN_TOOL_HANDLERS, registerTools } from "../index.js";
import { initializeToolRegistry } from "../registry.js";
import { getBuiltinToolMetadata, getToolsForSource } from "../../utils/tool-metadata.js";

// Import SQLite connector to ensure it's registered
import "../../connectors/sqlite/index.js";

/**
 * Every built-in tool is described in two tables keyed by tool name: its
 * metadata (utils/tool-metadata.ts) and its schema + handler (tools/index.ts).
 * A built-in missing from either would be registered wrongly, or listed by the
 * API as a custom tool — which is how health_check once ended up there.
 */
describe("built-in tool tables", () => {
  const sourceId = "readonly_limited";
  let manager: ConnectorManager;

  beforeAll(async () => {
    manager = await setupManagerWithFixture(FIXTURES.READONLY_MAXROWS);
    const { sources, tools } = loadFixtureConfig(FIXTURES.READONLY_MAXROWS);
    // Enable every built-in on one source, on top of the fixture's own tools
    const enabled = new Set((tools || []).filter((t) => t.source === sourceId).map((t) => t.name));
    initializeToolRegistry({
      sources,
      tools: [
        ...(tools || []),
        ...ALL_BUILTIN_TOOL_NAMES.filter((name) => !enabled.has(name)).map(
          (name) => ({ name, source: sourceId }) as any
        ),
      ],
    });
  }, 30000);

  afterAll(async () => {
    await manager?.disconnect();
  });

  it("has a handler entry for exactly the built-in tool names", () => {
    expect(Object.keys(BUILTIN_TOOL_HANDLERS).sort()).toEqual([...ALL_BUILTIN_TOOL_NAMES].sort());
  });

  it.each([...ALL_BUILTIN_TOOL_NAMES])("registers %s under the name and description the API lists", (name) => {
    const registered: Array<{ name: string; description: string }> = [];
    registerTools({
      registerTool: (toolName: string, config: { description: string }) => {
        registered.push({ name: toolName, description: config.description });
      },
    } as any);

    const metadata = getBuiltinToolMetadata(name, sourceId);
    // Multi-source fixture: the registered name carries the source suffix
    expect(metadata.name).toBe(`${name}_${sourceId}`);
    expect(registered).toContainEqual({ name: metadata.name, description: metadata.description });
    expect(getToolsForSource(sourceId)).toContainEqual(
      expect.objectContaining({ name: metadata.name, description: metadata.description })
    );
  });

  it("describes an opt-in health_check as the registered built-in, not as a custom tool", () => {
    const metadata = getBuiltinToolMetadata("health_check", sourceId);

    expect(getToolsForSource(sourceId).find((t) => t.name.startsWith("health_check"))).toEqual({
      name: metadata.name,
      description: metadata.description,
      parameters: [],
      readonly: true,
    });
  });
});
