import { describe, it, expect, beforeEach, afterEach, afterAll, vi, type MockInstance } from 'vitest';
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

const options = {
  targetHost: 'database.local',
  targetPort: 5432,
};

/**
 * Run establish() against the mocked ssh2 client, which always fails at connect,
 * and return the config handed to ssh2 — i.e. the auth that survived resolution.
 */
async function connectWith(config: SSHTunnelConfig): Promise<Record<string, unknown>> {
  await expect(new SSHTunnel().establish(config, options)).rejects.toThrow(
    'SSH connection error: mock connect failure'
  );
  expect(connectCalls).toHaveLength(1);
  return connectCalls[0];
}

describe('SSHTunnel', () => {
  beforeEach(() => {
    connectCalls.length = 0;
    // An agent socket exported in the developer's shell would satisfy SSH auth
    vi.stubEnv('SSH_AUTH_SOCK', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Tunnel State Management', () => {
    const config: SSHTunnelConfig = {
      host: 'ssh.example.com',
      username: 'testuser',
      password: 'testpass',
    };

    it('should reject concurrent establish calls', async () => {
      const tunnel = new SSHTunnel();

      // Start first establish call (fails via the mocked client's error, but
      // only after the second call below has already been rejected)
      const promise1 = tunnel.establish(config, options).catch(() => {});

      // Immediately try second establish call - should be rejected
      const promise2 = tunnel.establish(config, options);

      await expect(promise2).rejects.toThrow('SSH tunnel is already established');
      await promise1;
    });

    it('should start disconnected and reset connection state after failed establish', async () => {
      const tunnel = new SSHTunnel();
      expect(tunnel.getIsConnected()).toBe(false);
      expect(tunnel.getTunnelInfo()).toBeNull();

      // Missing both password and privateKey - will fail validation
      const noAuth: SSHTunnelConfig = { host: 'ssh.example.com', username: 'testuser' };
      await expect(tunnel.establish(noAuth, options)).rejects.toThrow();

      // After failure, isConnected should be false
      expect(tunnel.getIsConnected()).toBe(false);
      expect(tunnel.getTunnelInfo()).toBeNull();

      // Should be able to try establishing again (even though it will fail again)
      await expect(tunnel.establish(noAuth, options)).rejects.toThrow();
    });

    it('should handle close when not connected', async () => {
      const tunnel = new SSHTunnel();

      // Should not throw when closing disconnected tunnel
      await expect(tunnel.close()).resolves.toBeUndefined();
    });
  });

  describe('Private Key Resolution', () => {
    it('should accept base64-encoded private key', async () => {
      // A minimal PEM private key structure, base64-encoded
      const fakeKey = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg==\n-----END PRIVATE KEY-----\n';
      const base64Key = Buffer.from(fakeKey).toString('base64');

      // The base64 key passes local validation, so establish() proceeds to the
      // (mocked) SSH connection and fails there — not at key resolution.
      const call = await connectWith({ host: 'ssh.example.com', username: 'testuser', privateKey: base64Key });

      // The key handed to ssh2 must be the decoded PEM, proving the base64
      // content was recognized and decoded rather than treated as a file path.
      expect(Buffer.isBuffer(call.privateKey)).toBe(true);
      expect((call.privateKey as Buffer).toString('utf8')).toBe(fakeKey);
    });

    it('should reject invalid private key that is neither file nor base64', async () => {
      const config: SSHTunnelConfig = {
        host: 'ssh.example.com',
        username: 'testuser',
        privateKey: 'not-a-file-and-not-base64-key',
      };

      await expect(new SSHTunnel().establish(config, options)).rejects.toThrow(
        'SSH key is neither a valid file path nor a base64-encoded private key'
      );

      // Fails during local key resolution — ssh2 is never asked to connect.
      expect(connectCalls).toHaveLength(0);
    });
  });

  describe('SSH Agent', () => {
    // The tunnel only checks that the socket path exists, so plain files stand in
    // for agent sockets.
    const sockDir = mkdtempSync(join(tmpdir(), 'dbhub-ssh-agent-'));
    const ambientSock = join(sockDir, 'agent.sock');
    const configuredSock = join(sockDir, 'configured.sock');
    const missingSock = join(sockDir, 'missing.sock');
    writeFileSync(ambientSock, '');
    writeFileSync(configuredSock, '');

    let warnSpy: MockInstance;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(() => {
      rmSync(sockDir, { recursive: true, force: true });
    });

    it('should reject when no password, key, or agent is available', async () => {
      await expect(
        new SSHTunnel().establish({ host: 'ssh.example.com', username: 'testuser' }, options)
      ).rejects.toThrow(
        'Either password, privateKey, or an SSH agent (agent or SSH_AUTH_SOCK) must be provided for SSH authentication'
      );

      expect(connectCalls).toHaveLength(0);
    });

    it('should authenticate with the agent alone when SSH_AUTH_SOCK is set', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', ambientSock);

      const call = await connectWith({ host: 'ssh.example.com', username: 'testuser' });

      expect(call.agent).toBe(ambientSock);
      expect(call.password).toBeUndefined();
      expect(call.privateKey).toBeUndefined();
    });

    it('should offer the agent alongside an explicit password', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', ambientSock);

      const call = await connectWith({ host: 'ssh.example.com', username: 'testuser', password: 'secret' });

      expect(call).toMatchObject({ password: 'secret', agent: ambientSock });
    });

    it('should prefer a configured agent over SSH_AUTH_SOCK', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', ambientSock);

      const call = await connectWith({ host: 'ssh.example.com', username: 'testuser', agent: configuredSock });

      expect(call.agent).toBe(configuredSock);
    });

    // Windows agents are named pipes, so socket paths are not checked there
    it.skipIf(process.platform === 'win32')('should reject a configured agent socket that does not exist', async () => {
      await expect(
        new SSHTunnel().establish(
          { host: 'ssh.example.com', username: 'testuser', password: 'secret', agent: missingSock },
          options
        )
      ).rejects.toThrow(`SSH agent socket not found: ${missingSock}`);

      expect(connectCalls).toHaveLength(0);
    });

    // Windows agents are named pipes, so socket paths are not checked there
    it.skipIf(process.platform === 'win32')('should ignore a stale SSH_AUTH_SOCK', async () => {
      vi.stubEnv('SSH_AUTH_SOCK', missingSock);

      // With another auth method the connection proceeds without the agent...
      const call = await connectWith({ host: 'ssh.example.com', username: 'testuser', password: 'secret' });
      expect(call.agent).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Ignoring SSH_AUTH_SOCK'));

      // ...and on its own it does not count as an auth method.
      await expect(
        new SSHTunnel().establish({ host: 'ssh.example.com', username: 'testuser' }, options)
      ).rejects.toThrow('must be provided for SSH authentication');
    });

    it('should offer the configured agent to jump hosts', async () => {
      await expect(
        new SSHTunnel().establish(
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

      it.each([
        ['the agent', { agent: configuredSock }],
        ['the password', { password: 'secret' }],
      ])('should skip an undecryptable key from ~/.ssh/config and use %s', async (_method, fallback) => {
        const call = await connectWith({
          host: 'ssh.example.com',
          username: 'testuser',
          privateKey: base64Key,
          privateKeyDiscovered: true,
          ...fallback,
        });

        expect(call.privateKey).toBeUndefined();
        expect(call).toMatchObject(fallback);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping unusable SSH private key'));
      });

      it('should skip an undecryptable jump host key', async () => {
        await expect(
          new SSHTunnel().establish(
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
      });

      it('should skip a public key from ~/.ssh/config and use the agent', async () => {
        // e.g. `IdentityFile ~/.ssh/id_ed25519.pub`, which 1Password uses to pick an agent key
        const { publicKey } = generateKeyPairSync('ed25519');
        const sshPublicKey = Buffer.concat([
          Buffer.from('ssh-ed25519 '),
          Buffer.from(
            Buffer.concat([
              Buffer.from([0, 0, 0, 11]),
              Buffer.from('ssh-ed25519'),
              Buffer.from([0, 0, 0, 32]),
              publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
            ]).toString('base64')
          ),
        ]);
        const publicKeyPath = join(sockDir, 'id_ed25519.pub');
        writeFileSync(publicKeyPath, sshPublicKey);

        const call = await connectWith({
          host: 'ssh.example.com',
          username: 'testuser',
          privateKey: publicKeyPath,
          privateKeyDiscovered: true,
          agent: configuredSock,
        });

        expect(call.privateKey).toBeUndefined();
        expect(call.agent).toBe(configuredSock);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a private key'));
      });

      // Handed to ssh2 as-is, which rejects the connection with a parse error.
      it.each([
        ['an explicitly configured key', { privateKey: base64Key, agent: configuredSock }],
        ['a key from ~/.ssh/config that is the only method', { privateKey: base64Key, privateKeyDiscovered: true }],
      ])('should still hand %s to ssh2', async (_desc, auth) => {
        const call = await connectWith({ host: 'ssh.example.com', username: 'testuser', ...auth });

        expect(Buffer.isBuffer(call.privateKey)).toBe(true);
      });

      it('should keep a key from ~/.ssh/config that the passphrase decrypts', async () => {
        const call = await connectWith({
          host: 'ssh.example.com',
          username: 'testuser',
          privateKey: base64Key,
          privateKeyDiscovered: true,
          passphrase: 'secret',
          agent: configuredSock,
        });

        expect(Buffer.isBuffer(call.privateKey)).toBe(true);
        expect(call).toMatchObject({ passphrase: 'secret', agent: configuredSock });
      });
    });

    it('should not set agent when SSH_AUTH_SOCK is unset', async () => {
      const call = await connectWith({ host: 'ssh.example.com', username: 'testuser', password: 'secret' });

      expect(call.agent).toBeUndefined();
    });
  });
});
