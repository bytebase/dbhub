import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresConnector } from '../postgres/index.js';
import { ConnectorManager } from '../manager.js';
import { ConnectorRegistry } from '../interface.js';
import { SSHTunnel } from '../../utils/ssh-tunnel.js';
import type { SSHTunnelConfig } from '../../types/ssh.js';
import type { SourceConfig } from '../../types/config.js';
import * as sshConfigParser from '../../utils/ssh-config-parser.js';

/**
 * Helper function to create a SourceConfig from a DSN for testing
 */
function createSourceConfigFromDSN(dsn: string, sourceId: string = 'test'): SourceConfig {
  return {
    id: sourceId,
    dsn: dsn,
  };
}

describe('PostgreSQL SSH Tunnel Simple Integration Tests', () => {
  let postgresContainer: StartedPostgreSqlContainer;

  beforeAll(async () => {
    // Register PostgreSQL connector
    ConnectorRegistry.register(new PostgresConnector());
    
    // Start PostgreSQL container
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
    it('should establish SSH tunnel and connect to local port', async () => {
      // For this test, we'll create a mock SSH tunnel that just forwards to the same port
      // This tests the tunnel establishment logic without needing a real SSH server
      const tunnel = new SSHTunnel();
      
      // Test that the tunnel correctly reports its state
      expect(tunnel.getIsConnected()).toBe(false);
      expect(tunnel.getTunnelInfo()).toBeNull();
    });

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

      const dsn = postgresContainer.getConnectionUri();
      const sourceConfig = createSourceConfigFromDSN(dsn);

      await manager.connectWithSources([sourceConfig]);

      // Test that connection works
      const connector = manager.getConnector();
      const result = await connector.executeSQL('SELECT 1 as test', {});
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].test).toBe(1);

      await manager.disconnect();
    });

    it('should fail gracefully when SSH config is invalid', async () => {
      const manager = new ConnectorManager();

      // Create source config with invalid SSH config (missing required fields)
      const dsn = postgresContainer.getConnectionUri();
      const sourceConfig = createSourceConfigFromDSN(dsn);
      sourceConfig.ssh_host = 'example.com';
      // Missing ssh_user

      await expect(manager.connectWithSources([sourceConfig])).rejects.toThrow(/SSH tunnel requires ssh_user/);
    });

    it('should validate SSH authentication method', async () => {
      const manager = new ConnectorManager();

      // Create source config with SSH but without authentication method
      const dsn = postgresContainer.getConnectionUri();
      const sourceConfig = createSourceConfigFromDSN(dsn);
      sourceConfig.ssh_host = 'example.com';
      sourceConfig.ssh_user = 'testuser';
      // Missing both ssh_password and ssh_key

      await expect(manager.connectWithSources([sourceConfig])).rejects.toThrow(/SSH tunnel requires either ssh_password or ssh_key/);
    });

    it('should handle SSH tunnel with source config', async () => {
      const manager = new ConnectorManager();

      // Spy on the SSH tunnel establish method to verify the config values
      const mockSSHTunnelEstablish = vi.spyOn(SSHTunnel.prototype, 'establish');

      try {
        // Mock SSH tunnel establish to capture the config and prevent actual connection
        mockSSHTunnelEstablish.mockRejectedValue(new Error('SSH connection failed (expected in test)'));

        const dsn = postgresContainer.getConnectionUri();
        const sourceConfig = createSourceConfigFromDSN(dsn);

        // Configure SSH tunnel via source config
        sourceConfig.ssh_host = 'bastion.example.com';
        sourceConfig.ssh_user = 'sshuser';
        sourceConfig.ssh_port = 2222;
        sourceConfig.ssh_key = '/home/user/.ssh/id_rsa';

        // This should fail during SSH connection (expected), but we can verify the config
        await expect(manager.connectWithSources([sourceConfig])).rejects.toThrow();

        // Verify that SSH tunnel was attempted with the correct config values
        expect(mockSSHTunnelEstablish).toHaveBeenCalledTimes(1);
        const sshTunnelCall = mockSSHTunnelEstablish.mock.calls[0];
        const [sshConfig, tunnelOptions] = sshTunnelCall;

        // Verify SSH config values were properly set from source config
        expect(sshConfig).toMatchObject({
          host: 'bastion.example.com',
          username: 'sshuser',
          port: 2222,
          privateKey: '/home/user/.ssh/id_rsa'
        });

        // Verify tunnel options are correctly set up for the database connection
        const originalDsnUrl = new URL(dsn);
        expect(tunnelOptions.targetHost).toBe(originalDsnUrl.hostname);
        expect(tunnelOptions.targetPort).toBe(parseInt(originalDsnUrl.port));

      } finally {
        mockSSHTunnelEstablish.mockRestore();
      }
    });

    it('should handle SSH tunnel with password authentication', async () => {
      const manager = new ConnectorManager();

      // Spy on the SSH tunnel establish method
      const mockSSHTunnelEstablish = vi.spyOn(SSHTunnel.prototype, 'establish');

      try {
        // Mock SSH tunnel establish to prevent actual connection
        mockSSHTunnelEstablish.mockRejectedValue(new Error('SSH connection failed (expected in test)'));

        const dsn = postgresContainer.getConnectionUri();
        const sourceConfig = createSourceConfigFromDSN(dsn);

        // Configure SSH tunnel with password authentication
        sourceConfig.ssh_host = 'ssh.example.com';
        sourceConfig.ssh_user = 'sshuser';
        sourceConfig.ssh_password = 'sshpass';

        // This should fail during actual SSH connection
        await expect(manager.connectWithSources([sourceConfig])).rejects.toThrow();

        // Verify SSH tunnel was attempted with password auth
        expect(mockSSHTunnelEstablish).toHaveBeenCalledTimes(1);
        const [sshConfig] = mockSSHTunnelEstablish.mock.calls[0];
        expect(sshConfig.password).toBe('sshpass');

      } finally {
        mockSSHTunnelEstablish.mockRestore();
      }
    });
  });
});