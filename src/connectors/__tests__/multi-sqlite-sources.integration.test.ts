import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupManagerWithFixture, FIXTURES } from '../../__fixtures__/helpers.js';
import type { ConnectorManager } from '../manager.js';

// Import SQLite connector to ensure it's registered
import '../sqlite/index.js';

describe('Multiple SQLite Sources Integration Test (Issue #115)', () => {
  let manager: ConnectorManager;

  beforeAll(async () => {
    // Initialize ConnectorManager with multi-sqlite fixture
    // This fixture provides 3 in-memory SQLite databases: database_a, database_b, database_c
    manager = await setupManagerWithFixture(FIXTURES.MULTI_SQLITE);

    // Setup test data in database_a
    const connectorA = manager.getConnector('database_a');
    await connectorA.executeSQL(`
      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      )
    `, {});
    await connectorA.executeSQL(`
      INSERT INTO employees (name) VALUES ('Alice'), ('Bob')
    `, {});

    // Setup test data in database_b
    const connectorB = manager.getConnector('database_b');
    await connectorB.executeSQL(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL
      )
    `, {});
    await connectorB.executeSQL(`
      INSERT INTO products (title) VALUES ('Widget'), ('Gadget'), ('Doohickey')
    `, {});
  }, 30000);

  afterAll(async () => {
    // Cleanup: disconnect from in-memory databases
    if (manager) {
      await manager.disconnect();
    }
  });

  it('registers all configured source IDs', async () => {
    const sourceIds = manager.getSourceIds();
    expect(sourceIds).toEqual(['database_a', 'database_b', 'database_c']);
  });

  it('should not overwrite connections when connecting to multiple SQLite databases', async () => {
    // This is the core test for issue #115
    const connectorA = manager.getConnector('database_a');
    const connectorB = manager.getConnector('database_b');

    // Each database lists its own table and not the other's
    expect(await connectorA.getTables()).toEqual(['employees']);
    expect(await connectorB.getTables()).toEqual(['products']);

    // Query database_a
    const resultA = await connectorA.executeSQL('SELECT COUNT(*) as count FROM employees', {});
    expect(Number(resultA.resultSets[0].rows[0].count)).toBe(2);

    // Query database_b
    const resultB = await connectorB.executeSQL('SELECT COUNT(*) as count FROM products', {});
    expect(Number(resultB.resultSets[0].rows[0].count)).toBe(3);

    // Query database_a again to ensure it's still connected to the correct database
    const resultA2 = await connectorA.executeSQL('SELECT COUNT(*) as count FROM employees', {});
    expect(Number(resultA2.resultSets[0].rows[0].count)).toBe(2);

    // Verify that database_a doesn't have the products table
    await expect(
      connectorA.executeSQL('SELECT COUNT(*) as count FROM products', {})
    ).rejects.toThrow();

    // Verify that database_b doesn't have the employees table
    await expect(
      connectorB.executeSQL('SELECT COUNT(*) as count FROM employees', {})
    ).rejects.toThrow();
  });
});
