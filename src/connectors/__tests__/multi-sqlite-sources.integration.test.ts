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

  it('should maintain separate table structures for each database', async () => {
    const connectorA = manager.getConnector('database_a');
    const connectorB = manager.getConnector('database_b');

    const tablesA = await connectorA.getTables();
    const tablesB = await connectorB.getTables();

    // database_a should have 'employees' table
    expect(tablesA).toContain('employees');
    expect(tablesA).not.toContain('products');

    // database_b should have 'products' table
    expect(tablesB).toContain('products');
    expect(tablesB).not.toContain('employees');
  });

  it('should return correct connector for each source ID', async () => {
    const connectorA1 = manager.getConnector('database_a');
    const connectorA2 = manager.getConnector('database_a');
    const connectorB = manager.getConnector('database_b');

    // Same source ID should return the same connector instance
    expect(connectorA1).toBe(connectorA2);

    // Different source IDs should return different connector instances
    expect(connectorA1).not.toBe(connectorB);
  });

  it('should not overwrite connections when connecting to multiple SQLite databases', async () => {
    // This is the core test for issue #115
    // Query database_a
    const connectorA = manager.getConnector('database_a');
    const resultA = await connectorA.executeSQL('SELECT COUNT(*) as count FROM employees', {});
    expect(Number(resultA.resultSets[0].rows[0].count)).toBe(2);

    // Query database_b
    const connectorB = manager.getConnector('database_b');
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

  it('should handle inserts to each database independently', async () => {
    const connectorA = manager.getConnector('database_a');
    const connectorB = manager.getConnector('database_b');

    // Insert into database_a
    await connectorA.executeSQL("INSERT INTO employees (name) VALUES ('Charlie')", {});
    const resultA = await connectorA.executeSQL('SELECT COUNT(*) as count FROM employees', {});
    expect(Number(resultA.resultSets[0].rows[0].count)).toBe(3);

    // Insert into database_b
    await connectorB.executeSQL("INSERT INTO products (title) VALUES ('Thingamajig')", {});
    const resultB = await connectorB.executeSQL('SELECT COUNT(*) as count FROM products', {});
    expect(Number(resultB.resultSets[0].rows[0].count)).toBe(4);

    // Verify database_a still has 3 employees
    const resultA2 = await connectorA.executeSQL('SELECT COUNT(*) as count FROM employees', {});
    expect(Number(resultA2.resultSets[0].rows[0].count)).toBe(3);
  });

  it('should throw error for non-existent source ID', () => {
    expect(() => {
      manager.getConnector('non_existent_db');
    }).toThrow(/Source 'non_existent_db' not found/);
  });

  it('should return default (first) connector when no source ID provided', () => {
    const defaultConnector = manager.getConnector();
    const explicitFirstConnector = manager.getConnector('database_a');

    // Default connector should be the first source
    expect(defaultConnector).toBe(explicitFirstConnector);
  });
});
