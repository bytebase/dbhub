import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConnectorManager } from '../manager.js';
import type { SourceConfig } from '../../types/config.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Import SQLite connector to ensure it's registered
import '../sqlite/index.js';

describe('Multiple SQLite Sources Integration Test (Issue #115)', () => {
  let manager: ConnectorManager;
  let dbPathA: string;
  let dbPathB: string;

  beforeAll(async () => {
    // Create two separate temporary database files
    const tempDir = os.tmpdir();
    dbPathA = path.join(tempDir, `database_a_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.db`);
    dbPathB = path.join(tempDir, `database_b_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.db`);

    // Create the database files
    fs.writeFileSync(dbPathA, '');
    fs.writeFileSync(dbPathB, '');

    // Configure two SQLite sources
    const sources: SourceConfig[] = [
      {
        id: 'database_a',
        dsn: `sqlite://${dbPathA}`,
      },
      {
        id: 'database_b',
        dsn: `sqlite://${dbPathB}`,
      },
    ];

    // Initialize ConnectorManager with multiple sources
    manager = new ConnectorManager();
    await manager.connectWithSources(sources);

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
    // Cleanup
    if (manager) {
      await manager.disconnect();
    }

    // Clean up temporary database files
    if (fs.existsSync(dbPathA)) {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        fs.unlinkSync(dbPathA);
      } catch (error) {
        console.warn(`Failed to cleanup ${dbPathA}:`, error);
      }
    }
    if (fs.existsSync(dbPathB)) {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        fs.unlinkSync(dbPathB);
      } catch (error) {
        console.warn(`Failed to cleanup ${dbPathB}:`, error);
      }
    }
  });

  it('should connect to multiple SQLite databases independently', async () => {
    const sourceIds = manager.getSourceIds();
    expect(sourceIds).toEqual(['database_a', 'database_b']);
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

  it('should query correct data from database_a', async () => {
    const connectorA = manager.getConnector('database_a');
    const result = await connectorA.executeSQL('SELECT * FROM employees ORDER BY name', {});

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].name).toBe('Alice');
    expect(result.rows[1].name).toBe('Bob');
  });

  it('should query correct data from database_b', async () => {
    const connectorB = manager.getConnector('database_b');
    const result = await connectorB.executeSQL('SELECT * FROM products ORDER BY title', {});

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].title).toBe('Doohickey');
    expect(result.rows[1].title).toBe('Gadget');
    expect(result.rows[2].title).toBe('Widget');
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
    expect(Number(resultA.rows[0].count)).toBe(2);

    // Query database_b
    const connectorB = manager.getConnector('database_b');
    const resultB = await connectorB.executeSQL('SELECT COUNT(*) as count FROM products', {});
    expect(Number(resultB.rows[0].count)).toBe(3);

    // Query database_a again to ensure it's still connected to the correct database
    const resultA2 = await connectorA.executeSQL('SELECT COUNT(*) as count FROM employees', {});
    expect(Number(resultA2.rows[0].count)).toBe(2);

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
    expect(Number(resultA.rows[0].count)).toBe(3);

    // Insert into database_b
    await connectorB.executeSQL("INSERT INTO products (title) VALUES ('Thingamajig')", {});
    const resultB = await connectorB.executeSQL('SELECT COUNT(*) as count FROM products', {});
    expect(Number(resultB.rows[0].count)).toBe(4);

    // Verify database_a still has 3 employees
    const resultA2 = await connectorA.executeSQL('SELECT COUNT(*) as count FROM employees', {});
    expect(Number(resultA2.rows[0].count)).toBe(3);
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
