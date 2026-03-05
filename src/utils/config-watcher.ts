import fs from "fs";
import { loadTomlConfig, resolveTomlConfigPath } from "../config/toml-loader.js";
import { ConnectorManager } from "../connectors/manager.js";
import { initializeToolRegistry } from "../tools/registry.js";

const DEBOUNCE_MS = 500;

/**
 * Watch the TOML configuration file for changes and reload sources automatically.
 * Only applicable when using TOML-based configuration.
 */
export function startConfigWatcher(connectorManager: ConnectorManager): (() => void) | null {
  const configPath = resolveTomlConfigPath();
  if (!configPath) {
    return null;
  }

  let debounceTimer: NodeJS.Timeout | null = null;
  let isReloading = false;

  const reload = async () => {
    if (isReloading) {
      return;
    }
    isReloading = true;

    try {
      console.error(`\nDetected change in ${configPath}, reloading configuration...`);

      // Parse and validate new config — if this throws, keep existing connections
      const newConfig = loadTomlConfig();
      if (!newConfig) {
        console.error("Config reload: failed to load TOML config, keeping existing connections.");
        return;
      }

      // Save old config for rollback if reconnection fails
      const oldSources = connectorManager.getAllSourceConfigs();

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

        console.error("Configuration reloaded successfully.");
      } catch (connectError) {
        console.error("Failed to connect with new config, rolling back:", connectError);
        try {
          await connectorManager.connectWithSources(oldSources);
          initializeToolRegistry({ sources: oldSources });
          console.error("Rolled back to previous configuration.");
        } catch (rollbackError) {
          console.error("Rollback also failed, server has no active connections:", rollbackError);
        }
      }
    } catch (error) {
      console.error("Config reload failed, keeping existing connections:", error);
    } finally {
      isReloading = false;
    }
  };

  const watcher = fs.watch(configPath, (eventType) => {
    if (eventType === "change") {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(reload, DEBOUNCE_MS);
    }
  });

  watcher.on("error", (error) => {
    console.error("Config file watcher error:", error);
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
