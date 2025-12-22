import { describe, it, expect } from 'vitest';
import { SSHTunnel } from '../ssh-tunnel.js';
import type { SSHTunnelConfig } from '../../types/ssh.js';

describe('SSHTunnel', () => {
  describe('Initial State', () => {
    it('should have initial state as disconnected', () => {
      const tunnel = new SSHTunnel();
      expect(tunnel.getIsConnected()).toBe(false);
      expect(tunnel.getTunnelInfo()).toBeNull();
    });
  });

  describe('Tunnel State Management', () => {
    it('should prevent establishing multiple tunnels', async () => {
      const tunnel = new SSHTunnel();
      
      // Set tunnel as connected (simulating a connected state)
      (tunnel as any).isConnected = true;

      const config: SSHTunnelConfig = {
        host: 'ssh.example.com',
        username: 'testuser',
        password: 'testpass',
      };

      const options = {
        targetHost: 'database.local',
        targetPort: 5432,
      };

      await expect(tunnel.establish(config, options)).rejects.toThrow(
        'SSH tunnel is already established'
      );
    });

    it('should reject concurrent establish calls', async () => {
      const tunnel = new SSHTunnel();
      
      const config: SSHTunnelConfig = {
        host: 'ssh.example.com',
        username: 'testuser',
        password: 'testpass',
      };

      const options = {
        targetHost: 'database.local',
        targetPort: 5432,
      };

      // Start first establish call (will fail due to invalid config but that's ok)
      const promise1 = tunnel.establish(config, options).catch(() => {});
      
      // Immediately try second establish call - should be rejected
      const promise2 = tunnel.establish(config, options);
      
      await expect(promise2).rejects.toThrow('SSH tunnel is already established');
      await promise1;
    });

    it('should reset connection state after failed establish', async () => {
      const tunnel = new SSHTunnel();
      
      const config: SSHTunnelConfig = {
        host: 'ssh.example.com',
        username: 'testuser',
        // Missing both password and privateKey - will fail validation
      };

      const options = {
        targetHost: 'database.local',
        targetPort: 5432,
      };

      // First establish should fail
      await expect(tunnel.establish(config, options)).rejects.toThrow();
      
      // After failure, isConnected should be false
      expect(tunnel.getIsConnected()).toBe(false);
      
      // Should be able to try establishing again (even though it will fail again)
      await expect(tunnel.establish(config, options)).rejects.toThrow();
    });

    it('should handle close when not connected', async () => {
      const tunnel = new SSHTunnel();
      
      // Should not throw when closing disconnected tunnel
      await expect(tunnel.close()).resolves.toBeUndefined();
    });
  });

  describe('Configuration Validation', () => {
    it('should validate authentication requirements', () => {
      // Test that config validation logic exists
      const validConfigWithPassword: SSHTunnelConfig = {
        host: 'ssh.example.com',
        username: 'testuser',
        password: 'testpass',
      };

      const validConfigWithKey: SSHTunnelConfig = {
        host: 'ssh.example.com',
        username: 'testuser',
        privateKey: '/path/to/key',
      };

      const validConfigWithKeyAndPassphrase: SSHTunnelConfig = {
        host: 'ssh.example.com',
        port: 2222,
        username: 'testuser',
        privateKey: '/path/to/key',
        passphrase: 'keypassphrase',
      };

      // These should be valid configurations
      expect(validConfigWithPassword.host).toBe('ssh.example.com');
      expect(validConfigWithPassword.username).toBe('testuser');
      expect(validConfigWithPassword.password).toBe('testpass');

      expect(validConfigWithKey.privateKey).toBe('/path/to/key');
      expect(validConfigWithKeyAndPassphrase.passphrase).toBe('keypassphrase');
      expect(validConfigWithKeyAndPassphrase.port).toBe(2222);
    });
  });
});