import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SSHTunnel } from '../ssh-tunnel.js';
import type { SSHTunnelConfig } from '../../types/ssh.js';

// Capture the configs passed to ssh2's Client.connect so tests can assert on
// them without any real network I/O.
const { connectCalls } = vi.hoisted(() => ({
  connectCalls: [] as Array<Record<string, unknown>>,
}));

// Mock ssh2 so no test ever dials a real SSH server. The mocked client records
// the connect config, never emits 'ready', and asynchronously emits 'error' to
// simulate an unreachable host — establish() always settles deterministically.
vi.mock('ssh2', async () => {
  // Key parsing is pure, so the real implementation is safe to keep. It lives on
  // the default export, mirroring how ssh-tunnel.ts has to import it.
  const actual = await vi.importActual<{ default: typeof import('ssh2') }>('ssh2');
  class MockClient {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    on(event: string, cb: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
      return this;
    }

    removeListener(event: string, cb: (...args: unknown[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      this.listeners.set(event, arr.filter((fn) => fn !== cb));
      return this;
    }

    connect(config: Record<string, unknown>): void {
      connectCalls.push(config);
      queueMicrotask(() => {
        for (const cb of this.listeners.get('error') ?? []) {
          cb(new Error('mock connect failure'));
        }
      });
    }

    destroy(): void {}

    end(): void {}
  }

  const { utils } = actual.default;
  return { Client: MockClient, default: { Client: MockClient, utils } };
});

describe('SSHTunnel', () => {
  beforeEach(() => {
    connectCalls.length = 0;
    // An agent socket exported in the developer's shell would satisfy SSH auth
    vi.stubEnv('SSH_AUTH_SOCK', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

      // Start first establish call (fails via the mocked client's error, but
      // only after the second call below has already been rejected)
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

  describe('Private Key Resolution', () => {
    it('should accept base64-encoded private key', async () => {
      const tunnel = new SSHTunnel();
      // A minimal PEM private key structure, base64-encoded
      const fakeKey = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg==\n-----END PRIVATE KEY-----\n';
      const base64Key = Buffer.from(fakeKey).toString('base64');

      const config: SSHTunnelConfig = {
        host: 'ssh.example.com',
        username: 'testuser',
        privateKey: base64Key,
      };

      const options = {
        targetHost: 'database.local',
        targetPort: 5432,
      };

      // The base64 key passes local validation, so establish() proceeds to the
      // (mocked) SSH connection and fails there — not at key resolution.
      await expect(tunnel.establish(config, options)).rejects.toThrow(
        'SSH connection error: mock connect failure'
      );

      // The key handed to ssh2 must be the decoded PEM, proving the base64
      // content was recognized and decoded rather than treated as a file path.
      expect(connectCalls).toHaveLength(1);
      expect(Buffer.isBuffer(connectCalls[0].privateKey)).toBe(true);
      expect((connectCalls[0].privateKey as Buffer).toString('utf8')).toBe(fakeKey);
    });

    it('should reject invalid private key that is neither file nor base64', async () => {
      const tunnel = new SSHTunnel();

      const config: SSHTunnelConfig = {
        host: 'ssh.example.com',
        username: 'testuser',
        privateKey: 'not-a-file-and-not-base64-key',
      };

      const options = {
        targetHost: 'database.local',
        targetPort: 5432,
      };

      await expect(tunnel.establish(config, options)).rejects.toThrow(
        'SSH key is neither a valid file path nor a base64-encoded private key'
      );

      // Fails during local key resolution — ssh2 is never asked to connect.
      expect(connectCalls).toHaveLength(0);
    });
  });

  describe('SSH Agent', () => {
    const options = {
      targetHost: 'database.local',
      targetPort: 5432,
    };

    // The tunnel only checks that the socket path exists, so plain files stand in
    // for agent sockets.
    const sockDir = mkdtempSync(join(tmpdir(), 'dbhub-ssh-agent-'));
    const ambientSock = join(sockDir, 'agent.sock');
    const configuredSock = join(sockDir, 'configured.sock');
    const missingSock = join(sockDir, 'missing.sock');
    writeFileSync(ambientSock, '');
    writeFileSync(configuredSock, '');

    afterAll(() => {
      rmSync(sockDir, { recursive: true, force: true });
    });

    it('should reject when no password, key, or agent is available', async () => {
      const tunnel = new SSHTunnel();

      await expect(
        tunnel.establish({ host: 'ssh.example.com', username: 'testuser' }, options)
      ).rejects.toThrow(
        'Either password, privateKey, or an SSH agent (agent or SSH_AUTH_SOCK) must be provided for SSH authentication'
      );

      expect(connectCalls).toHaveLength(0);
    });

    it('should authenticate with the agent alone when SSH_AUTH_SOCK is set', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', ambientSock);
      const tunnel = new SSHTunnel();

      await expect(
        tunnel.establish({ host: 'ssh.example.com', username: 'testuser' }, options)
      ).rejects.toThrow('SSH connection error: mock connect failure');

      expect(connectCalls).toHaveLength(1);
      expect(connectCalls[0].agent).toBe(ambientSock);
      expect(connectCalls[0].password).toBeUndefined();
      expect(connectCalls[0].privateKey).toBeUndefined();
    });

    it('should offer the agent alongside an explicit password', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', ambientSock);
      const tunnel = new SSHTunnel();

      await expect(
        tunnel.establish({ host: 'ssh.example.com', username: 'testuser', password: 'secret' }, options)
      ).rejects.toThrow('SSH connection error: mock connect failure');

      expect(connectCalls[0]).toMatchObject({ password: 'secret', agent: ambientSock });
    });

    it('should authenticate with a configured agent when SSH_AUTH_SOCK is unset', async () => {
      const tunnel = new SSHTunnel();

      await expect(
        tunnel.establish({ host: 'ssh.example.com', username: 'testuser', agent: configuredSock }, options)
      ).rejects.toThrow('SSH connection error: mock connect failure');

      expect(connectCalls).toHaveLength(1);
      expect(connectCalls[0].agent).toBe(configuredSock);
    });

    it('should prefer a configured agent over SSH_AUTH_SOCK', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', ambientSock);
      const tunnel = new SSHTunnel();

      await expect(
        tunnel.establish({ host: 'ssh.example.com', username: 'testuser', agent: configuredSock }, options)
      ).rejects.toThrow('SSH connection error: mock connect failure');

      expect(connectCalls[0].agent).toBe(configuredSock);
    });

    it('should reject a configured agent socket that does not exist', async () => {
      const tunnel = new SSHTunnel();

      await expect(
        tunnel.establish(
          { host: 'ssh.example.com', username: 'testuser', password: 'secret', agent: missingSock },
          options
        )
      ).rejects.toThrow(`SSH agent socket not found: ${missingSock}`);

      expect(connectCalls).toHaveLength(0);
    });

    it('should ignore a stale SSH_AUTH_SOCK', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', missingSock);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        // With another auth method the connection proceeds without the agent...
        await expect(
          new SSHTunnel().establish({ host: 'ssh.example.com', username: 'testuser', password: 'secret' }, options)
        ).rejects.toThrow('SSH connection error: mock connect failure');
        expect(connectCalls[0].agent).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring SSH_AUTH_SOCK'));

        // ...and on its own it does not count as an auth method.
        await expect(
          new SSHTunnel().establish({ host: 'ssh.example.com', username: 'testuser' }, options)
        ).rejects.toThrow('must be provided for SSH authentication');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should offer the configured agent to jump hosts', async () => {
      const tunnel = new SSHTunnel();

      await expect(
        tunnel.establish(
          { host: 'ssh.example.com', username: 'testuser', agent: configuredSock, proxyJump: 'jump.example.com' },
          options
        )
      ).rejects.toThrow('mock connect failure');

      expect(connectCalls[0]).toMatchObject({ host: 'jump.example.com', agent: configuredSock });
    });

    describe('with an encrypted private key', () => {
      const { privateKey: encryptedKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'secret' },
      });
      const base64Key = Buffer.from(encryptedKey).toString('base64');

      it('should skip an undecryptable key from ~/.ssh/config and use the agent', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const tunnel = new SSHTunnel();

        try {
          await expect(
            tunnel.establish(
              {
                host: 'ssh.example.com',
                username: 'testuser',
                privateKey: base64Key,
                privateKeyDiscovered: true,
                agent: configuredSock,
              },
              options
            )
          ).rejects.toThrow('SSH connection error: mock connect failure');

          expect(connectCalls).toHaveLength(1);
          expect(connectCalls[0].privateKey).toBeUndefined();
          expect(connectCalls[0].agent).toBe(configuredSock);
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping unusable SSH private key'));
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('should skip an undecryptable key from ~/.ssh/config and use the password', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const tunnel = new SSHTunnel();

        try {
          await expect(
            tunnel.establish(
              {
                host: 'ssh.example.com',
                username: 'testuser',
                privateKey: base64Key,
                privateKeyDiscovered: true,
                password: 'secret',
              },
              options
            )
          ).rejects.toThrow('SSH connection error: mock connect failure');

          expect(connectCalls[0].privateKey).toBeUndefined();
          expect(connectCalls[0].password).toBe('secret');
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('should skip an undecryptable jump host key', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const tunnel = new SSHTunnel();

        try {
          await expect(
            tunnel.establish(
              {
                host: 'ssh.example.com',
                username: 'testuser',
                agent: configuredSock,
                resolvedJumpHosts: [{ host: 'jump.example.com', port: 22, privateKey: base64Key }],
              },
              options
            )
          ).rejects.toThrow('mock connect failure');

          expect(connectCalls[0]).toMatchObject({ host: 'jump.example.com', agent: configuredSock });
          expect(connectCalls[0].privateKey).toBeUndefined();
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('should not skip an explicitly configured key', async () => {
        const tunnel = new SSHTunnel();

        await expect(
          tunnel.establish(
            { host: 'ssh.example.com', username: 'testuser', privateKey: base64Key, agent: configuredSock },
            options
          )
        ).rejects.toThrow('SSH connection error: mock connect failure');

        // Handed to ssh2 as-is, which rejects the connection with a parse error.
        expect(Buffer.isBuffer(connectCalls[0].privateKey)).toBe(true);
      });

      it('should keep a key from ~/.ssh/config that the passphrase decrypts', async () => {
        const tunnel = new SSHTunnel();

        await expect(
          tunnel.establish(
            {
              host: 'ssh.example.com',
              username: 'testuser',
              privateKey: base64Key,
              privateKeyDiscovered: true,
              passphrase: 'secret',
              agent: configuredSock,
            },
            options
          )
        ).rejects.toThrow('SSH connection error: mock connect failure');

        expect(Buffer.isBuffer(connectCalls[0].privateKey)).toBe(true);
        expect(connectCalls[0]).toMatchObject({ passphrase: 'secret', agent: configuredSock });
      });

      it('should still hand a key from ~/.ssh/config to ssh2 when it is the only method', async () => {
        const tunnel = new SSHTunnel();

        await expect(
          tunnel.establish(
            { host: 'ssh.example.com', username: 'testuser', privateKey: base64Key, privateKeyDiscovered: true },
            options
          )
        ).rejects.toThrow('SSH connection error: mock connect failure');

        expect(Buffer.isBuffer(connectCalls[0].privateKey)).toBe(true);
      });
    });

    it('should not set agent when SSH_AUTH_SOCK is unset', async () => {
      const tunnel = new SSHTunnel();

      await expect(
        tunnel.establish({ host: 'ssh.example.com', username: 'testuser', password: 'secret' }, options)
      ).rejects.toThrow('SSH connection error: mock connect failure');

      expect(connectCalls[0].agent).toBeUndefined();
    });
  });
});
