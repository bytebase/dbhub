import fs from "fs";
import { loadTomlConfig, resolveTomlConfigPath } from "../config/toml-loader.js";
import { ConnectorManager } from "../connectors/manager.js";
import { getToolRegistry } from "../tools/registry.js";
import { setFileSourceIds, withSourceLock } from "./source-mutation.js";
import type { SourceConfig, ToolConfig } from "../types/config.js";

const DEBOUNCE_MS = 500;

interface ConfigWatcherOptions {
  connectorManager: ConnectorManager;
  initialTools?: ToolConfig[];
}

/**
 * Watch the TOML configuration file for changes and reload sources automatically.
 * Only applicable when using TOML-based configuration.
 *
 * A reload is a diff against the last known-good file: sources that are unchanged
 * keep their connections and in-flight queries; only added, removed, or edited
 * sources (or sources whose tools changed) are touched. Sources added through the
 * sources API are not part of the file and are never affected by a reload.
 *
 * NOTE: In STDIO transport mode, the MCP server's tool list is registered once at
 * startup. Hot reload updates the underlying database connections and tool registry,
 * but STDIO clients won't see added/removed tools until a full server restart.
 * HTTP transport creates a fresh server per request, so tool changes take effect immediately.
 */
export function startConfigWatcher(options: ConfigWatcherOptions): (() => void) | null {
  const { connectorManager, initialTools } = options;
  const configPath = resolveTomlConfigPath();
  if (!configPath) {
    return null;
  }

  let debounceTimer: NodeJS.Timeout | null = null;
  let isReloading = false;
  let reloadPending = false;

  // Track last known-good config for rollback (sources + tools)
  let lastGoodSources: SourceConfig[] = connectorManager.getAllSourceConfigs();
  let lastGoodTools: ToolConfig[] = initialTools ?? [];

  const scheduleReload = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(reload, DEBOUNCE_MS);
  };

  const reload = async () => {
    if (isReloading) {
      reloadPending = true;
      return;
    }
    isReloading = true;
    reloadPending = false;

    try {
      console.error(`\nDetected change in ${configPath}, reloading configuration...`);

      // Parse and validate new config — if this throws, keep existing connections
      const newConfig = loadTomlConfig();
      if (!newConfig) {
        console.error("Config reload: failed to load TOML config, keeping existing connections.");
        return;
      }

      await withSourceLock(async () => {
        const result = await applySourceDiff(
          connectorManager,
          { sources: lastGoodSources, tools: lastGoodTools },
          { sources: newConfig.sources, tools: newConfig.tools ?? [] }
        );
        lastGoodSources = result.sources;
        lastGoodTools = result.tools;
        setFileSourceIds(lastGoodSources.map((s) => s.id));
      });

      console.error("Configuration reloaded successfully.");
    } catch (error) {
      console.error("Config reload failed, keeping existing connections:", error);
    } finally {
      isReloading = false;
      if (reloadPending) {
        reloadPending = false;
        scheduleReload();
      }
    }
  };

  const watcher = fs.watch(configPath, (eventType) => {
    if (eventType === "change") {
      scheduleReload();
    }
  });
  watcher.unref?.();
  watcher.on("error", (err) => {
    console.error("Config file watcher error:", err);
  });

  console.error(`Watching ${configPath} for changes (hot reload enabled)`);

  // Return cleanup function
  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    watcher.close();
  };
}

interface FileConfig {
  sources: SourceConfig[];
  tools: ToolConfig[];
}

/**
 * Apply `next` on top of `current` one source at a time. Returns the config that
 * is actually in effect afterwards: a source whose new definition fails to connect
 * is rolled back to its previous definition (or dropped, if it had none).
 */
async function applySourceDiff(
  connectorManager: ConnectorManager,
  current: FileConfig,
  next: FileConfig
): Promise<FileConfig> {
  const registry = getToolRegistry();
  const currentById = new Map(current.sources.map((s) => [s.id, s]));
  const nextById = new Map(next.sources.map((s) => [s.id, s]));
  const toolsFor = (id: string, tools: ToolConfig[]) => tools.filter((t) => t.source === id);
  const unchanged = (id: string) =>
    JSON.stringify(currentById.get(id)) === JSON.stringify(nextById.get(id)) &&
    JSON.stringify(toolsFor(id, current.tools)) === JSON.stringify(toolsFor(id, next.tools));

  const effective = new Map<string, { source: SourceConfig; tools: ToolConfig[] }>();
  for (const source of current.sources) {
    effective.set(source.id, { source, tools: toolsFor(source.id, current.tools) });
  }

  for (const id of currentById.keys()) {
    if (nextById.has(id)) continue;
    await connectorManager.removeSource(id);
    registry.removeSource(id);
    effective.delete(id);
    console.error(`Source '${id}' removed`);
  }

  for (const [id, source] of nextById) {
    if (currentById.has(id) && unchanged(id)) continue;
    const tools = toolsFor(id, next.tools);
    try {
      await connectorManager.addSource(source);
      registry.setSourceTools(id, tools);
      effective.set(id, { source, tools });
      console.error(`Source '${id}' ${currentById.has(id) ? "updated" : "added"}`);
    } catch (error) {
      console.error(`Source '${id}': failed to apply new config, rolling back:`, error);
      const previous = effective.get(id);
      if (!previous) {
        registry.removeSource(id);
        continue;
      }
      try {
        await connectorManager.addSource(previous.source);
        registry.setSourceTools(id, previous.tools);
        console.error(`Source '${id}' rolled back to previous configuration.`);
      } catch (rollbackError) {
        console.error(`Source '${id}': rollback also failed, source is unavailable:`, rollbackError);
        registry.removeSource(id);
        effective.delete(id);
      }
    }
  }

  return {
    sources: [...effective.values()].map((e) => e.source),
    tools: [...effective.values()].flatMap((e) => e.tools),
  };
}
