import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ConnectorManager } from '../manager.js';
import { SSHTunnel } from '../../utils/ssh-tunnel.js';
import type { SourceConfig } from '../../types/config.js';

// Import the PostgreSQL connector to ensure it's registered
import '../postgres/index.js';

describe('PostgreSQL SSH Tunnel Simple Integration Tests', () => {
  let postgresContainer: StartedPostgreSqlContainer;

  /** A source for the test database, optionally behind an SSH host. */
  const sourceFor = (ssh: Partial<SourceConfig> = {}): SourceConfig => ({
    id: 'test',
    type: 'postgres',
    dsn: postgresContainer.getConnectionUri(),
    ...ssh,
  });

  beforeAll(async () => {
    postgresContainer = await new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('testdb')
      .withUsername('testuser')
      .withPassword('testpass')
      .start();
  }, 60000); // 1 minute timeout for container startup

  afterAll(async () => {
    await postgresContainer?.stop();
  });

  describe('SSH Tunnel Basic Functionality', () => {
    it('should parse DSN correctly when SSH tunnel is configured', async () => {
      const manager = new ConnectorManager();

      // Test DSN parsing with getDefaultPort
      const testCases = [
        { dsn: 'postgres://user:pass@host:5432/db', expectedPort: 5432 },
        { dsn: 'mysql://user:pass@host:3306/db', expectedPort: 3306 },
        { dsn: 'mariadb://user:pass@host:3306/db', expectedPort: 3306 },
        { dsn: 'sqlserver://user:pass@host:1433/db', expectedPort: 1433 },
      ];

      for (const testCase of testCases) {
        // Access private method through reflection for testing
        const port = (manager as any).getDefaultPort(testCase.dsn);
        expect(port).toBe(testCase.expectedPort);
      }
    });

    it('should handle connection without SSH tunnel', async () => {
      const manager = new ConnectorManager();

      // Make sure no SSH config is set
      delete process.env.SSH_HOST;

      await manager.connectWithSources([sourceFor()]);

      // Test that connection works
      const connector = manager.getConnector();
      const result = await connector.executeSQL('SELECT 1 as test', {});
      expect(result.resultSets[0].rows).toHaveLength(1);
      expect(result.resultSets[0].rows[0].test).toBe(1);

      await manager.disconnect();
    });

    it.each([
      {
        auth: 'a private key and a custom port',
        ssh: { ssh_host: 'bastion.example.com', ssh_user: 'sshuser', ssh_port: 2222, ssh_key: '/home/user/.ssh/id_rsa' },
        expected: { host: 'bastion.example.com', username: 'sshuser', port: 2222, privateKey: '/home/user/.ssh/id_rsa' },
      },
      {
        auth: 'a password',
        ssh: { ssh_host: 'ssh.example.com', ssh_user: 'sshuser', ssh_password: 'sshpass' },
        expected: { host: 'ssh.example.com', username: 'sshuser', password: 'sshpass' },
      },
    ])('should open the tunnel from the source config with $auth', async ({ ssh, expected }) => {
      // Stop at tunnel establishment (no SSH server here) and capture what it was handed.
      const establish = vi
        .spyOn(SSHTunnel.prototype, 'establish')
        .mockRejectedValue(new Error('SSH connection failed (expected in test)'));

      try {
        const source = sourceFor(ssh);
        await expect(new ConnectorManager().connectWithSources([source])).rejects.toThrow();

        expect(establish).toHaveBeenCalledTimes(1);
        const [sshConfig, tunnelOptions] = establish.mock.calls[0];
        expect(sshConfig).toMatchObject(expected);

        // The tunnel targets the database the DSN names.
        const dsnUrl = new URL(source.dsn!);
        expect(tunnelOptions.targetHost).toBe(dsnUrl.hostname);
        expect(tunnelOptions.targetPort).toBe(parseInt(dsnUrl.port));
      } finally {
        establish.mockRestore();
      }
    });
  });
});
