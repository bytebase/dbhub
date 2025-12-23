/**
 * Test fixture utilities for TOML configuration files
 *
 * This module provides helper functions to work with TOML test fixtures,
 * making it easy to reference and load test configurations in integration tests.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { loadTomlConfig } from '../config/toml-loader.js';
import { ConnectorManager } from '../connectors/manager.js';
import type { SourceConfig } from '../types/config.js';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get the absolute path to a TOML fixture file
 *
 * @param fixtureName - Name of the fixture file (with or without .toml extension)
 * @returns Absolute path to the fixture file
 *
 * @example
 * ```ts
 * const configPath = fixtureTomlPath('multi-sqlite');
 * // Returns: /absolute/path/to/src/__fixtures__/toml/multi-sqlite.toml
 * ```
 */
export function fixtureTomlPath(fixtureName: string): string {
  const name = fixtureName.endsWith('.toml') ? fixtureName : `${fixtureName}.toml`;
  return path.join(__dirname, 'toml', name);
}

/**
 * Load a TOML fixture and return its parsed configuration
 *
 * @param fixtureName - Name of the fixture file (without .toml extension)
 * @returns Object containing sources array and optional tools array
 * @throws Error if fixture file doesn't exist or is invalid
 *
 * @example
 * ```ts
 * const { sources, tools } = loadFixtureConfig('multi-sqlite');
 * // Returns: { sources: [...], tools: [...] }
 * ```
 */
export function loadFixtureConfig(fixtureName: string): { sources: SourceConfig[]; tools?: any[] } {
  const fixturePath = fixtureTomlPath(fixtureName);

  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture file not found: ${fixturePath}`);
  }

  // Temporarily set --config flag to point to fixture
  const originalArgv = process.argv;
  try {
    process.argv = ['node', 'test', '--config', fixturePath];
    const config = loadTomlConfig();

    if (!config || !config.sources) {
      throw new Error(`Failed to load fixture: ${fixtureName}`);
    }

    return {
      sources: config.sources,
      tools: config.tools,
    };
  } finally {
    process.argv = originalArgv;
  }
}

/**
 * Create and connect a ConnectorManager with sources from a TOML fixture
 *
 * This is a convenience function that combines loading a fixture config
 * and initializing a ConnectorManager with those sources.
 *
 * @param fixtureName - Name of the fixture file (without .toml extension)
 * @returns Promise resolving to a connected ConnectorManager instance
 * @throws Error if fixture loading or connection fails
 *
 * @example
 * ```ts
 * const manager = await setupManagerWithFixture('multi-sqlite');
 * const connector = manager.getConnector('database_a');
 * await connector.executeSQL('SELECT * FROM users', {});
 *
 * // Don't forget to cleanup
 * await manager.disconnect();
 * ```
 */
export async function setupManagerWithFixture(fixtureName: string): Promise<ConnectorManager> {
  const { sources } = loadFixtureConfig(fixtureName);
  const manager = new ConnectorManager();
  await manager.connectWithSources(sources);
  return manager;
}


/**
 * Available TOML test fixtures
 */
export const FIXTURES = {
  MULTI_SQLITE: 'multi-sqlite',
  READONLY_MAXROWS: 'readonly-maxrows',
} as const;
