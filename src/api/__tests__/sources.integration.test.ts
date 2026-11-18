import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Application } from 'express';
import { setupManagerWithFixture, FIXTURES, loadFixtureConfig } from '../../__fixtures__/helpers.js';
import type { ConnectorManager } from '../../connectors/manager.js';
import { listSources, getSource } from '../sources.js';
import type { components } from '../openapi.js';
import { Server } from 'http';
import { initializeToolRegistry } from '../../tools/registry.js';

// Import SQLite connector to ensure it's registered
import '../../connectors/sqlite/index.js';

type DataSource = components['schemas']['DataSource'];
type ErrorResponse = components['schemas']['Error'];

describe('Data Sources API Integration Tests', () => {
  let manager: ConnectorManager;
  let app: Application;
  let server: Server;
  let BASE_URL: string;

  beforeAll(async () => {
    // Initialize ConnectorManager with readonly-maxrows fixture
    // This fixture provides 3 SQLite sources with different execution options:
    // - readonly_limited: readonly=true, max_rows=100
    // - writable_limited: readonly=false, max_rows=500
    // - writable_unlimited: readonly=false, no max_rows
    manager = await setupManagerWithFixture(FIXTURES.READONLY_MAXROWS);

    // Initialize ToolRegistry with fixture config
    const { sources, tools } = loadFixtureConfig(FIXTURES.READONLY_MAXROWS);
    initializeToolRegistry({ sources, tools: tools || [] });

    // Set up Express app with API routes
    app = express();
    app.use(express.json());
    app.get('/api/sources', listSources);
    app.get('/api/sources/:sourceId', getSource);

    // Start server on an ephemeral port to avoid conflicts
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not report a bound port');
    }
    BASE_URL = `http://localhost:${address.port}`;
  }, 30000);

  afterAll(async () => {
    // Cleanup
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    if (manager) {
      await manager.disconnect();
    }
  });

  describe('GET /api/sources', () => {
    it('should return array of all data sources', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      const sources = (await response.json()) as DataSource[];
      expect(Array.isArray(sources)).toBe(true);
      expect(sources).toHaveLength(3);
    });

    it('should include correct source IDs', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      const ids = sources.map((s) => s.id);
      expect(ids).toEqual(['readonly_limited', 'writable_limited', 'writable_unlimited']);
    });

    it('should include database type for all sources', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      sources.forEach((source) => {
        expect(source.type).toBe('sqlite');
      });
    });

    it('should include execution options on tools', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      // First source has execute_sql tool with readonly and max_rows
      const firstExecuteSql = sources[0].tools.find(t => t.name.startsWith('execute_sql'));
      expect(firstExecuteSql?.readonly).toBe(true);
      expect(firstExecuteSql?.max_rows).toBe(100);

      // Second source has execute_sql tool with different settings
      const secondExecuteSql = sources[1].tools.find(t => t.name.startsWith('execute_sql'));
      expect(secondExecuteSql?.readonly).toBe(false);
      expect(secondExecuteSql?.max_rows).toBe(500);

      // Third source has execute_sql tool with no explicit settings
      const thirdExecuteSql = sources[2].tools.find(t => t.name.startsWith('execute_sql'));
      expect(thirdExecuteSql?.readonly).toBeUndefined();
      expect(thirdExecuteSql?.max_rows).toBeUndefined();
    });

    it('should include database connection details', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      sources.forEach((source) => {
        expect(source.database).toBe(':memory:');
        expect(source.id).toBeDefined();
        expect(source.type).toBe('sqlite');
      });
    });

    it('should not include sensitive fields like passwords', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      sources.forEach((source) => {
        expect(source).not.toHaveProperty('password');
        expect(source).not.toHaveProperty('ssh_password');
        expect(source).not.toHaveProperty('ssh_key');
        expect(source).not.toHaveProperty('ssh_passphrase');
      });
    });

    it('should include tools array for all sources', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      sources.forEach((source) => {
        expect(source.tools).toBeDefined();
        expect(Array.isArray(source.tools)).toBe(true);
        expect(source.tools.length).toBeGreaterThan(0);
      });
    });

    it('should include execute_sql tools with correct naming', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      // Find sources by ID to avoid relying on array order
      const readonlySource = sources.find(s => s.id === 'readonly_limited');
      const writableSource = sources.find(s => s.id === 'writable_limited');
      const unlimitedSource = sources.find(s => s.id === 'writable_unlimited');

      expect(readonlySource?.tools[0].name).toBe('execute_sql_readonly_limited');
      expect(writableSource?.tools[0].name).toBe('execute_sql_writable_limited');
      expect(unlimitedSource?.tools[0].name).toBe('execute_sql_writable_unlimited');
    });

    it('should include source ID and type in tool descriptions', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      sources.forEach((source) => {
        const tool = source.tools[0];
        expect(tool.description).toContain(source.id);
        expect(tool.description).toContain(source.type);
      });
    });

    it('should include sql parameter in execute_sql tool', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      sources.forEach((source) => {
        const tool = source.tools[0];
        const sqlParam = tool.parameters.find((p) => p.name === 'sql');

        expect(sqlParam).toBeDefined();
        expect(sqlParam!.type).toBe('string');
        expect(sqlParam!.required).toBe(true);
        expect(sqlParam!.description).toContain('SQL');
      });
    });

    it('should include description when present', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      // First source has a description
      const readonlySource = sources.find(s => s.id === 'readonly_limited');
      expect(readonlySource?.description).toBe('Read-only database for safe queries');

      // Other sources don't have descriptions
      const writableSource = sources.find(s => s.id === 'writable_limited');
      expect(writableSource?.description).toBeUndefined();
    });
  });

  describe('GET /api/sources/{source-id}', () => {
    it('should return specific source by ID', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/readonly_limited`);
      expect(response.status).toBe(200);

      const source = (await response.json()) as DataSource;
      expect(source.id).toBe('readonly_limited');
      expect(source.type).toBe('sqlite');

      // Check execute_sql tool has readonly and max_rows
      const executeSql = source.tools.find(t => t.name.startsWith('execute_sql'));
      expect(executeSql?.readonly).toBe(true);
      expect(executeSql?.max_rows).toBe(100);
    });

    it('should return correct data for another source', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/writable_limited`);
      expect(response.status).toBe(200);

      const source = (await response.json()) as DataSource;
      expect(source.id).toBe('writable_limited');

      // Check execute_sql tool has readonly and max_rows
      const executeSql = source.tools.find(t => t.name.startsWith('execute_sql'));
      expect(executeSql?.readonly).toBe(false);
      expect(executeSql?.max_rows).toBe(500);
    });

    it('should return 404 for non-existent source', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/nonexistent_source`);
      expect(response.status).toBe(404);

      const error = (await response.json()) as ErrorResponse;
      expect(error.error).toBe('Source not found');
      expect(error.source_id).toBe('nonexistent_source');
    });

    it('should include tools array in single source response', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/readonly_limited`);
      const source = (await response.json()) as DataSource;

      expect(source.tools).toBeDefined();
      expect(Array.isArray(source.tools)).toBe(true);
      expect(source.tools.length).toBeGreaterThan(0);
    });

    it('should include correct tool name for specific source', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/writable_limited`);
      const source = (await response.json()) as DataSource;

      expect(source.tools[0].name).toBe('execute_sql_writable_limited');
      expect(source.tools[0].description).toContain('writable_limited');
      expect(source.tools[0].description).toContain('sqlite');
    });

    it('should include complete tool metadata in single source response', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/readonly_limited`);
      const source = (await response.json()) as DataSource;

      const tool = source.tools[0];
      expect(tool.name).toBe('execute_sql_readonly_limited');
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(Array.isArray(tool.parameters)).toBe(true);

      // Verify sql parameter exists
      const sqlParam = tool.parameters.find((p) => p.name === 'sql');
      expect(sqlParam).toBeDefined();
      expect(sqlParam!.type).toBe('string');
      expect(sqlParam!.required).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle special characters in source ID for 404', async () => {
      const specialId = 'test@#$%';
      const response = await fetch(`${BASE_URL}/api/sources/${encodeURIComponent(specialId)}`);
      expect(response.status).toBe(404);

      const error = (await response.json()) as ErrorResponse;
      expect(error.source_id).toBe(specialId);
    });
  });
});
