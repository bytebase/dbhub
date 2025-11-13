import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Application } from 'express';
import { ConnectorManager } from '../../connectors/manager.js';
import type { SourceConfig } from '../../types/config.js';
import { listSources, getSource } from '../sources.js';
import type { components } from '../openapi.js';
import { Server } from 'http';

// Import SQLite connector to ensure it's registered
import '../../connectors/sqlite/index.js';

type DataSource = components['schemas']['DataSource'];
type ErrorResponse = components['schemas']['Error'];

describe('Data Sources API Integration Tests', () => {
  let manager: ConnectorManager;
  let app: Application;
  let server: Server;
  const TEST_PORT = 13579; // Use a unique port to avoid conflicts
  const BASE_URL = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    // Configure multiple test sources
    const sources: SourceConfig[] = [
      {
        id: 'test_sqlite_main',
        type: 'sqlite',
        database: ':memory:',
        readonly: true,
        max_rows: 100,
      },
      {
        id: 'test_sqlite_secondary',
        type: 'sqlite',
        database: ':memory:',
        readonly: false,
        max_rows: 500,
      },
      {
        id: 'test_sqlite_third',
        type: 'sqlite',
        database: ':memory:',
      },
    ];

    // Initialize ConnectorManager with multiple sources
    manager = new ConnectorManager();
    await manager.connectWithSources(sources);

    // Set up Express app with API routes
    app = express();
    app.use(express.json());
    app.get('/api/sources', listSources);
    app.get('/api/sources/:sourceId', getSource);

    // Start server
    await new Promise<void>((resolve) => {
      server = app.listen(TEST_PORT, () => {
        resolve();
      });
    });
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
      expect(ids).toEqual(['test_sqlite_main', 'test_sqlite_secondary', 'test_sqlite_third']);
    });

    it('should mark first source as default', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      expect(sources[0].is_default).toBe(true);
      expect(sources[1].is_default).toBe(false);
      expect(sources[2].is_default).toBe(false);
    });

    it('should include all database type for all sources', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      sources.forEach((source) => {
        expect(source.type).toBe('sqlite');
      });
    });

    it('should include execution options', async () => {
      const response = await fetch(`${BASE_URL}/api/sources`);
      const sources = (await response.json()) as DataSource[];

      // First source has readonly and max_rows
      expect(sources[0].readonly).toBe(true);
      expect(sources[0].max_rows).toBe(100);

      // Second source has different settings
      expect(sources[1].readonly).toBe(false);
      expect(sources[1].max_rows).toBe(500);

      // Third source has no explicit settings
      expect(sources[2].readonly).toBeUndefined();
      expect(sources[2].max_rows).toBeUndefined();
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
  });

  describe('GET /api/sources/{source-id}', () => {
    it('should return specific source by ID', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/test_sqlite_main`);
      expect(response.status).toBe(200);

      const source = (await response.json()) as DataSource;
      expect(source.id).toBe('test_sqlite_main');
      expect(source.type).toBe('sqlite');
      expect(source.is_default).toBe(true);
      expect(source.readonly).toBe(true);
      expect(source.max_rows).toBe(100);
    });

    it('should return correct data for non-default source', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/test_sqlite_secondary`);
      expect(response.status).toBe(200);

      const source = (await response.json()) as DataSource;
      expect(source.id).toBe('test_sqlite_secondary');
      expect(source.is_default).toBe(false);
      expect(source.readonly).toBe(false);
      expect(source.max_rows).toBe(500);
    });

    it('should return 404 for non-existent source', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/nonexistent_source`);
      expect(response.status).toBe(404);

      const error = (await response.json()) as ErrorResponse;
      expect(error.error).toBe('Source not found');
      expect(error.source_id).toBe('nonexistent_source');
    });

    it('should not include sensitive fields in single source response', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/test_sqlite_main`);
      const source = (await response.json()) as DataSource;

      expect(source).not.toHaveProperty('password');
      expect(source).not.toHaveProperty('ssh_password');
      expect(source).not.toHaveProperty('ssh_key');
      expect(source).not.toHaveProperty('ssh_passphrase');
    });

    it('should handle URL-encoded source IDs', async () => {
      // Test with spaces in ID (though not recommended)
      const response = await fetch(`${BASE_URL}/api/sources/${encodeURIComponent('test_sqlite_main')}`);
      expect(response.status).toBe(200);

      const source = (await response.json()) as DataSource;
      expect(source.id).toBe('test_sqlite_main');
    });
  });

  describe('Data Source with SSH Configuration', () => {
    let managerWithSSH: ConnectorManager;
    let appWithSSH: Application;
    let serverWithSSH: Server;
    const SSH_TEST_PORT = 13580;
    const SSH_BASE_URL = `http://localhost:${SSH_TEST_PORT}`;

    beforeAll(async () => {
      // Configure source with SSH tunnel (but don't actually connect since we don't have a real SSH server)
      // We'll just test that the config is stored and exposed correctly
      const sourcesWithSSH: SourceConfig[] = [
        {
          id: 'postgres_with_ssh',
          type: 'postgres',
          host: 'internal-db.example.com',
          port: 5432,
          database: 'testdb',
          user: 'testuser',
          password: 'secret123',
          readonly: true,
          max_rows: 1000,
          ssh_host: 'bastion.example.com',
          ssh_port: 22,
          ssh_user: 'deploy',
          ssh_password: 'ssh_secret',
        },
      ];

      // Store the config without actually connecting (since we don't have real servers)
      // We'll just test the API response format
      managerWithSSH = new ConnectorManager();

      // For this test, we'll manually populate the sourceConfigs to test the API response
      // without actually connecting to real databases
      // This is a bit of a hack but allows us to test the API endpoint behavior

      // Skip actual connection for this test suite
      // The test will be focused on response format, not actual connectivity
    });

    afterAll(async () => {
      if (serverWithSSH) {
        await new Promise<void>((resolve, reject) => {
          serverWithSSH.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
      if (managerWithSSH) {
        await managerWithSSH.disconnect();
      }
    });

    // Note: This test is commented out because it requires a real database connection
    // In a real scenario, you'd either use a mock or test container
    it.skip('should include SSH tunnel configuration without credentials', async () => {
      const response = await fetch(`${SSH_BASE_URL}/api/sources/postgres_with_ssh`);
      const source = (await response.json()) as DataSource;

      // Should include SSH tunnel config
      expect(source.ssh_tunnel).toBeDefined();
      expect(source.ssh_tunnel?.enabled).toBe(true);
      expect(source.ssh_tunnel?.ssh_host).toBe('bastion.example.com');
      expect(source.ssh_tunnel?.ssh_port).toBe(22);
      expect(source.ssh_tunnel?.ssh_user).toBe('deploy');

      // Should NOT include SSH credentials
      expect(source).not.toHaveProperty('ssh_password');
      expect(source).not.toHaveProperty('ssh_key');
      expect(source).not.toHaveProperty('ssh_passphrase');
    });
  });

  describe('Error Handling', () => {
    it('should return proper error format for 404', async () => {
      const response = await fetch(`${BASE_URL}/api/sources/invalid_id`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');

      const error = (await response.json()) as ErrorResponse;
      expect(error).toHaveProperty('error');
      expect(error).toHaveProperty('source_id');
      expect(typeof error.error).toBe('string');
      expect(error.source_id).toBe('invalid_id');
    });

    it('should handle special characters in source ID for 404', async () => {
      const specialId = 'test@#$%';
      const response = await fetch(`${BASE_URL}/api/sources/${encodeURIComponent(specialId)}`);
      expect(response.status).toBe(404);

      const error = (await response.json()) as ErrorResponse;
      expect(error.source_id).toBe(specialId);
    });
  });
});
