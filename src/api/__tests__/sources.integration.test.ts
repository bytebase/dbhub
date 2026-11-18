import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FIXTURES, loadFixtureConfig } from '../../__fixtures__/helpers.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { listSources, getSource } from '../sources.js';
import type { components } from '../openapi.js';
import { initializeToolRegistry } from '../../tools/registry.js';
import { startApiServer } from './test-server.js';

// Import SQLite connector to ensure it's registered
import '../../connectors/sqlite/index.js';

type ErrorResponse = components['schemas']['Error'];

const executeSqlTool = (
  sourceId: string,
  options: { readonly?: boolean; max_rows?: number } = {},
  type = 'sqlite'
) => ({
  name: `execute_sql_${sourceId}`,
  // The description names the source and its database type
  description: expect.stringContaining(`'${sourceId}' ${type} database`),
  parameters: [{ name: 'sql', type: 'string', required: true, description: expect.stringContaining('SQL') }],
  ...options,
});

// The readonly-maxrows fixture as the API presents it. Compared with toEqual,
// so a source or tool carries exactly these fields: execution options appear
// only where the tool is configured with them, `description` only where the
// source has one, and nothing else from the source config leaks through.
const expectedSources = [
  {
    id: 'readonly_limited',
    type: 'sqlite',
    database: ':memory:',
    description: 'Read-only database for safe queries',
    tools: [executeSqlTool('readonly_limited', { readonly: true, max_rows: 100 })],
  },
  {
    id: 'writable_limited',
    type: 'sqlite',
    database: ':memory:',
    tools: [executeSqlTool('writable_limited', { readonly: false, max_rows: 500 })],
  },
  {
    // No [[tools]] entries: gets the default built-ins, with no execution options
    id: 'writable_unlimited',
    type: 'sqlite',
    database: ':memory:',
    tools: [
      executeSqlTool('writable_unlimited'),
      expect.objectContaining({ name: 'search_objects_writable_unlimited', readonly: true }),
    ],
  },
  {
    // The tunneled-credentials fixture: a network source reached over SSH.
    // Host, port, database and user are shown, and where the tunnel goes;
    // the DSN, the database password and the SSH password are not.
    id: 'tunneled_pg',
    type: 'postgres',
    description: 'Reached through a bastion',
    host: 'db.internal',
    port: 5433,
    database: 'appdb',
    user: 'app_user',
    ssh_tunnel: { enabled: true, ssh_host: 'bastion.example.com', ssh_port: 2222, ssh_user: 'deploy' },
    tools: [
      executeSqlTool('tunneled_pg', {}, 'postgres'),
      expect.objectContaining({ name: 'search_objects_tunneled_pg', readonly: true }),
    ],
  },
];

describe('Data Sources API Integration Tests', () => {
  let manager: ConnectorManager;
  let server: Awaited<ReturnType<typeof startApiServer>>;

  beforeAll(async () => {
    // Initialize ConnectorManager and ToolRegistry with the readonly-maxrows
    // fixture (3 SQLite sources with different execution options) plus the
    // tunneled-credentials one (a lazy PostgreSQL source, never connected)
    const { sources: sqliteSources, tools } = loadFixtureConfig(FIXTURES.READONLY_MAXROWS);
    const sources = [...sqliteSources, ...loadFixtureConfig(FIXTURES.TUNNELED_CREDENTIALS).sources];
    manager = new ConnectorManager();
    await manager.connectWithSources(sources);
    initializeToolRegistry({ sources, tools: tools || [] });

    server = await startApiServer({ '/api/sources': listSources, '/api/sources/:sourceId': getSource });
  }, 30000);

  afterAll(async () => {
    await server?.close();
    await manager?.disconnect();
  });

  describe('GET /api/sources', () => {
    it('should return every data source with its connection details and tools', async () => {
      const response = await fetch(`${server.baseUrl}/api/sources`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = await response.text();
      expect(JSON.parse(body)).toEqual(expectedSources);
      // No credential reaches the response under any field, tool text included
      expect(body).not.toContain('db-secret-password');
      expect(body).not.toContain('ssh-secret-password');
    });
  });

  describe('GET /api/sources/{source-id}', () => {
    it.each(expectedSources.map((source) => [source.id, source] as const))(
      'should return %s as the list presents it',
      async (sourceId, expected) => {
        const response = await fetch(`${server.baseUrl}/api/sources/${sourceId}`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
      }
    );

    it.each(['nonexistent_source', 'test@#$%'])('should return 404 for non-existent source %s', async (sourceId) => {
      const response = await fetch(`${server.baseUrl}/api/sources/${encodeURIComponent(sourceId)}`);

      expect(response.status).toBe(404);
      expect((await response.json()) as ErrorResponse).toEqual({ error: 'Source not found', source_id: sourceId });
    });
  });
});
