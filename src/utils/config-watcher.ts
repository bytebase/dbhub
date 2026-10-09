import fs from "fs";
import { loadTomlConfig, resolveTomlConfigPath } from "../config/toml-loader.js";
import { ConnectorManager } from "../connectors/manager.js";
import { initializeToolRegistry } from "../tools/registry.js";
import type { SourceConfig } from "../types/config.js";

const DEBOUNCE_MS = 500;

interface ConfigWatcherOptions {
  connectorManager: ConnectorManager;
}

/** Stable, key-order-independent comparison of two source configs. */
export function sourceConfigEquals(a: SourceConfig, b: SourceConfig): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Move the connector manager from `oldSources` to `newSources` one source at a time.
 * Unchanged sources are left alone, so their pools keep serving requests throughout.
 *
 * Returns the sources that are live afterwards, in `newSources` order. A changed
 * source that fails to connect is rolled back to its previous config; a new source
 * that fails is skipped. Either way the other sources are unaffected.
 */
export async function applySourceDiff(
  connectorManager: ConnectorManager,
  oldSources: SourceConfig[],
  newSources: SourceConfig[]
): Promise<SourceConfig[]> {
  const oldById = new Map(oldSources.map(s => [s.id, s]));
  const newById = new Map(newSources.map(s => [s.id, s]));
  const applied = new Map<string, SourceConfig>();

  for (const oldSource of oldSources) {
    const newSource = newById.get(oldSource.id);
    if (!newSource) {
      console.error(`Config reload: removing source '${oldSource.id}'`);
      await connectorManager.removeSource(oldSource.id);
    } else if (sourceConfigEquals(oldSource, newSource)) {
      applied.set(oldSource.id, oldSource);
    }
  }

  for (const newSource of newSources) {
    if (applied.has(newSource.id)) {
      continue;
    }
    const oldSource = oldById.get(newSource.id);
    if (oldSource) {
      console.error(`Config reload: reconnecting changed source '${newSource.id}'`);
      await connectorManager.removeSource(newSource.id);
    } else {
      console.error(`Config reload: adding source '${newSource.id}'`);
    }

    try {
      await connectorManager.addSource(newSource);
      applied.set(newSource.id, newSource);
    } catch (error) {
      console.error(`Config reload: failed to connect source '${newSource.id}':`, error);
      if (oldSource) {
        try {
          await connectorManager.addSource(oldSource);
          applied.set(oldSource.id, oldSource);
          console.error(`Config reload: rolled back source '${oldSource.id}' to its previous config.`);
        } catch (rollbackError) {
          console.error(`Config reload: rollback of source '${oldSource.id}' also failed:`, rollbackError);
        }
      }
    }
  }

  // Keep the default (first) source and tool ordering in line with the file.
  const order = newSources.map(s => s.id);
  connectorManager.reorderSources(order);
  return order.filter(id => applied.has(id)).map(id => applied.get(id)!);
}

/**
 * Watch the TOML configuration file for changes and reload sources automatically.
 * Only applicable when using TOML-based configuration.
 *
 * NOTE: In STDIO transport mode, the MCP server's tool list is registered once at
 * startup. Hot reload updates the underlying database connections and tool registry,
 * but STDIO clients won't see added/removed tools until a full server restart.
 * HTTP transport creates a fresh server per request, so tool changes take effect immediately.
 */
export function startConfigWatcher(options: ConfigWatcherOptions): (() => void) | null {
  const { connectorManager } = options;
  const configPath = resolveTomlConfigPath();
  if (!configPath) {
    return null;
  }

  let debounceTimer: NodeJS.Timeout | null = null;
  let isReloading = false;
  let reloadPending = false;

  // Sources currently live in the manager; each reload is a diff against this list.
  let lastGoodSources: SourceConfig[] = connectorManager.getAllSourceConfigs();

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

      const applied = await applySourceDiff(connectorManager, lastGoodSources, newConfig.sources);

      // Tools may only reference sources that are actually live; drop the rest so the
      // registry does not reject the whole config over one source that failed to connect.
      const appliedIds = new Set(applied.map(s => s.id));
      const tools = newConfig.tools?.filter(t => appliedIds.has(t.source));

      initializeToolRegistry({ sources: applied, tools });
      lastGoodSources = applied;

      if (applied.length === newConfig.sources.length) {
        console.error("Configuration reloaded successfully.");
      } else {
        console.error(
          `Configuration reloaded with ${newConfig.sources.length - applied.length} source(s) unavailable.`
        );
      }
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
