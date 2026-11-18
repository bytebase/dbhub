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

  const getJson = async <T>(path: string): Promise<{ response: Response; body: T }> => {
    const response = await fetch(`${BASE_URL}${path}`);
    return { response, body: (await response.json()) as T };
  };

  describe('GET /api/sources', () => {
    it('lists every source in config order with its connection details', async () => {
      const { response, body: sources } = await getJson<DataSource[]>('/api/sources');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');

      expect(sources).toHaveLength(3);
      expect(sources).toMatchObject([
        { id: 'readonly_limited', type: 'sqlite', database: ':memory:', description: 'Read-only database for safe queries' },
        { id: 'writable_limited', type: 'sqlite', database: ':memory:' },
        { id: 'writable_unlimited', type: 'sqlite', database: ':memory:' },
      ]);
      // `description` appears only where the source has one
      expect(sources[1].description).toBeUndefined();
    });

    it('embeds each source\'s tools, named for the source, with execute_sql\'s options', async () => {
      const { body: sources } = await getJson<DataSource[]>('/api/sources');

      // Tool names, descriptions and parameters come from getToolsForSource,
      // which is tested in utils/__tests__/tool-metadata.integration.test.ts;
      // here it is enough that they are embedded per source.
      const executeSql = sources.map((source) => source.tools[0]);
      expect(executeSql.map((tool) => tool.name)).toEqual([
        'execute_sql_readonly_limited',
        'execute_sql_writable_limited',
        'execute_sql_writable_unlimited',
      ]);
      expect(executeSql.map((tool) => [tool.readonly, tool.max_rows])).toEqual([
        [true, 100],
        [false, 500],
        [undefined, undefined],
      ]);
      sources.forEach((source) => {
        const tool = source.tools[0];
        expect(tool.description).toContain(source.id);
        expect(tool.description).toContain(source.type);
        expect(tool.parameters).toContainEqual(
          expect.objectContaining({ name: 'sql', type: 'string', required: true })
        );
      });
    });

    it('should not include sensitive fields like passwords', async () => {
      const { body: sources } = await getJson<DataSource[]>('/api/sources');

      sources.forEach((source) => {
        expect(source).not.toHaveProperty('password');
        expect(source).not.toHaveProperty('ssh_password');
        expect(source).not.toHaveProperty('ssh_key');
        expect(source).not.toHaveProperty('ssh_passphrase');
      });
    });
  });

  describe('GET /api/sources/{source-id}', () => {
    it('returns one source, shaped exactly like its entry in the list', async () => {
      const { body: sources } = await getJson<DataSource[]>('/api/sources');

      // Both endpoints go through the same mapper, so the list assertions
      // above hold for the detail endpoint as long as the two agree.
      for (const listed of sources) {
        const { response, body } = await getJson<DataSource>(`/api/sources/${listed.id}`);
        expect(response.status).toBe(200);
        expect(body).toEqual(listed);
      }
    });

    it('should return 404 for non-existent source', async () => {
      const { response, body: error } = await getJson<ErrorResponse>('/api/sources/nonexistent_source');
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(error.error).toBe('Source not found');
      expect(error.source_id).toBe('nonexistent_source');
    });

    it('should decode special characters in the source ID for 404', async () => {
      const specialId = 'test@#$%';
      const { response, body: error } = await getJson<ErrorResponse>(
        `/api/sources/${encodeURIComponent(specialId)}`
      );
      expect(response.status).toBe(404);
      expect(error.source_id).toBe(specialId);
    });
  });
});
