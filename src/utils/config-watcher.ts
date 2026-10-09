import fs from "fs";
import { loadTomlConfig, resolveTomlConfigPath } from "../config/toml-loader.js";
import { ConnectorManager } from "../connectors/manager.js";
import { initializeToolRegistry, ToolRegistry } from "../tools/registry.js";
import type { SourceConfig, ToolConfig } from "../types/config.js";

const DEBOUNCE_MS = 500;

interface ConfigWatcherOptions {
  connectorManager: ConnectorManager;
  initialTools?: ToolConfig[];
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
 * Pick the tools to register after a reload. A tool may only reference a live source,
 * so the registry does not reject the whole config over one source that failed to
 * connect. A source that was rolled back to its previous config keeps its previous
 * tools too: the new file's tools were written against the config that did not apply.
 */
export function selectTools(
  applied: SourceConfig[],
  rolledBack: Set<string>,
  newTools: ToolConfig[] | undefined,
  oldTools: ToolConfig[] | undefined
): ToolConfig[] | undefined {
  if (newTools === undefined && oldTools === undefined) {
    return undefined;
  }
  const liveIds = new Set(applied.map(s => s.id));
  return [
    ...(newTools ?? []).filter(t => liveIds.has(t.source) && !rolledBack.has(t.source)),
    ...(oldTools ?? []).filter(t => rolledBack.has(t.source)),
  ];
}

export interface SourceDiffResult {
  /** Sources live after the reload, in file order. */
  sources: SourceConfig[];
  /** Ids whose new config failed to connect and were restored to their previous config. */
  rolledBack: Set<string>;
}

/**
 * Move the connector manager from `oldSources` to `newSources` one source at a time.
 * Unchanged sources are left alone, so their pools keep serving requests throughout.
 *
 * Returns the sources that are live afterwards, in `newSources` order, and the ids
 * that were rolled back. A changed source that fails to connect is rolled back to its
 * previous config; a new source that fails is skipped. Either way the other sources
 * are unaffected.
 */
export async function applySourceDiff(
  connectorManager: ConnectorManager,
  oldSources: SourceConfig[],
  newSources: SourceConfig[]
): Promise<SourceDiffResult> {
  const oldById = new Map(oldSources.map(s => [s.id, s]));
  const newById = new Map(newSources.map(s => [s.id, s]));
  const applied = new Map<string, SourceConfig>();
  const rolledBack = new Set<string>();

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
          rolledBack.add(oldSource.id);
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
  return {
    sources: order.filter(id => applied.has(id)).map(id => applied.get(id)!),
    rolledBack,
  };
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
  const { connectorManager, initialTools } = options;
  const configPath = resolveTomlConfigPath();
  if (!configPath) {
    return null;
  }

  let debounceTimer: NodeJS.Timeout | null = null;
  let isReloading = false;
  let reloadPending = false;

  // Sources (and their tools) currently live in the manager; each reload is a diff
  // against this list.
  let lastGoodSources: SourceConfig[] = connectorManager.getAllSourceConfigs();
  let lastGoodTools: ToolConfig[] | undefined = initialTools;

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

      // The registry validates more than the loader (custom tool parameters, duplicate
      // tool names). Run that validation on the new file before touching any
      // connection, so a bad file is rejected whole and nothing is left half-applied.
      new ToolRegistry({ sources: newConfig.sources, tools: newConfig.tools });

      const { sources: applied, rolledBack } = await applySourceDiff(
        connectorManager,
        lastGoodSources,
        newConfig.sources
      );
      // The manager now holds `applied`, whatever happens to the registry below.
      lastGoodSources = applied;

      let live = applied;
      let tools = selectTools(applied, rolledBack, newConfig.tools, lastGoodTools);
      try {
        initializeToolRegistry({ sources: live, tools });
      } catch (error) {
        // The new file validated on its own, so the only possible conflict is between
        // a rolled-back source's previous tools and the new file's tools (e.g. a custom
        // tool name moved to another source). Take the rolled-back sources offline
        // rather than serve them with the wrong tools.
        if (rolledBack.size === 0) {
          throw error;
        }
        console.error(
          `Config reload: previous tools of rolled-back source(s) ${[...rolledBack].join(", ")} ` +
            `conflict with the new configuration; taking them offline:`,
          error
        );
        for (const id of rolledBack) {
          await connectorManager.removeSource(id);
        }
        live = applied.filter(s => !rolledBack.has(s.id));
        lastGoodSources = live;
        tools = selectTools(live, new Set(), newConfig.tools, undefined);
        initializeToolRegistry({ sources: live, tools });
      }
      lastGoodTools = tools;

      const unavailable = newConfig.sources.length - live.length;
      if (unavailable === 0 && rolledBack.size === 0) {
        console.error("Configuration reloaded successfully.");
      } else {
        console.error(
          `Configuration reloaded with ${unavailable} source(s) unavailable and ` +
            `${rolledBack.size} source(s) rolled back to their previous configuration.`
        );
      }
    } catch (error) {
      console.error("Config reload failed:", error);
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
