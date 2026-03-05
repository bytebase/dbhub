import fs from "fs";
import { loadTomlConfig, resolveTomlConfigPath } from "../config/toml-loader.js";
import { ConnectorManager } from "../connectors/manager.js";
import { initializeToolRegistry } from "../tools/registry.js";
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

      // Save current config for rollback
      const oldSources = lastGoodSources;
      const oldTools = lastGoodTools;

      // Disconnect all existing sources
      await connectorManager.disconnect();

      try {
        // Reconnect with new sources
        await connectorManager.connectWithSources(newConfig.sources);

        // Re-initialize tool registry with new config
        initializeToolRegistry({
          sources: newConfig.sources,
          tools: newConfig.tools,
        });

        // Update last known-good config
        lastGoodSources = newConfig.sources;
        lastGoodTools = newConfig.tools;

        console.error("Configuration reloaded successfully.");
      } catch (connectError) {
        console.error("Failed to connect with new config, rolling back:", connectError);
        // Clean up any partial connections before rollback
        try { await connectorManager.disconnect(); } catch { /* best effort */ }
        try {
          await connectorManager.connectWithSources(oldSources);
          initializeToolRegistry({ sources: oldSources, tools: oldTools });
          console.error("Rolled back to previous configuration.");
        } catch (rollbackError) {
          console.error("Rollback also failed, server has no active connections:", rollbackError);
        }
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
