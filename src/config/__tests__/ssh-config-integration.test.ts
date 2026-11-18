import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveSSHConfig } from '../env.js';
import { join } from 'path';
import { parseSSHConfig } from '../../utils/ssh-config-parser.js';

// Only the ~/.ssh/config lookup is replaced; the alias heuristic
// (looksLikeSSHAlias) and the default config path are the real ones.
vi.mock('../../utils/ssh-config-parser.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/ssh-config-parser.js')>()),
  parseSSHConfig: vi.fn(),
}));

describe('SSH Config Integration', () => {
  const originalArgs = process.argv;

  // What ~/.ssh/config holds for the alias `mybastion`
  const bastion = {
    host: 'bastion.example.com',
    username: 'ubuntu',
    port: 2222,
    privateKey: '/home/user/.ssh/id_rsa',
  };

  // Values exported in the developer's shell must not leak into a test, nor
  // one test's values into the next.
  const clearSSHEnv = (): void => {
    for (const name of ['SSH_HOST', 'SSH_USER', 'SSH_PORT', 'SSH_KEY', 'SSH_PASSWORD', 'SSH_AUTH_SOCK']) {
      delete process.env[name];
    }
  };

  beforeEach(() => {
    clearSSHEnv();
    // Unless a test says otherwise, `mybastion` is the only alias in the config
    vi.mocked(parseSSHConfig).mockReset();
    vi.mocked(parseSSHConfig).mockImplementation((hostAlias: string) =>
      hostAlias === 'mybastion' ? { ...bastion } : null
    );
  });

  afterEach(() => {
    process.argv = originalArgs;
    clearSSHEnv();
  });

  it.each([
    ['--ssh-host', ['--ssh-host=mybastion'], {}],
    ['SSH_HOST', [], { SSH_HOST: 'mybastion' }],
  ])('should resolve SSH config from a host alias given via %s', (_label, argv, env) => {
    process.argv = ['node', 'index.js', ...argv];
    Object.assign(process.env, env);

    const result = resolveSSHConfig();

    expect(result?.config).toMatchObject(bastion);
    expect(result?.source).toContain('SSH config for host \'mybastion\'');
  });

  it('should allow command line to override SSH config values', () => {
    process.argv = ['node', 'index.js', '--ssh-host=mybastion', '--ssh-user=override-user'];

    const result = resolveSSHConfig();

    // Command line overrides config
    expect(result?.config).toMatchObject({ ...bastion, username: 'override-user' });
  });

  it('should not use SSH config for direct hostnames', () => {
    process.argv = ['node', 'index.js', '--ssh-host=direct.example.com', '--ssh-user=myuser', '--ssh-password=mypass'];

    const result = resolveSSHConfig();

    expect(result?.config).toMatchObject({
      host: 'direct.example.com',
      username: 'myuser',
      password: 'mypass'
    });
    expect(result?.source).not.toContain('SSH config');
    expect(parseSSHConfig).not.toHaveBeenCalled();
  });

  it('should require SSH user when only host is provided', () => {
    // An alias that ~/.ssh/config does not define
    process.argv = ['node', 'index.js', '--ssh-host=unknown-host'];

    expect(() => resolveSSHConfig()).toThrow('SSH tunnel configuration requires at least --ssh-host and --ssh-user');
  });

  it('should require an auth method when no password, key, or agent is available', () => {
    process.argv = ['node', 'index.js', '--ssh-host=direct.example.com', '--ssh-user=myuser'];

    expect(() => resolveSSHConfig()).toThrow(
      'SSH tunnel configuration requires either --ssh-password or --ssh-key (or an SSH agent via --ssh-agent or SSH_AUTH_SOCK) for authentication'
    );
  });

  it('should accept an SSH agent as the only auth method', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    process.argv = ['node', 'index.js', '--ssh-host=direct.example.com', '--ssh-user=myuser'];

    const result = resolveSSHConfig();

    expect(result?.config).toMatchObject({ host: 'direct.example.com', username: 'myuser' });
    expect(result?.config.password).toBeUndefined();
    expect(result?.config.privateKey).toBeUndefined();
  });

  it('should accept --ssh-agent as the only auth method', () => {
    process.argv = [
      'node', 'index.js', '--ssh-host=direct.example.com', '--ssh-user=myuser', '--ssh-agent=~/agent.sock'
    ];

    const result = resolveSSHConfig();

    expect(result?.config.agent).toBe(join(process.env.HOME || '', 'agent.sock'));
    expect(result?.source).toContain('ssh-agent from command line');
  });

  it('should exit when --ssh-agent is given without a value', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit: ${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      process.argv = ['node', 'index.js', '--ssh-host=direct.example.com', '--ssh-user=myuser', '--ssh-agent'];

      expect(() => resolveSSHConfig()).toThrow('process.exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--ssh-agent requires a value'));
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('should treat --ssh-key as explicit even when the host resolves from SSH config', () => {
    vi.mocked(parseSSHConfig).mockReturnValue({ ...bastion, privateKeyDiscovered: true });

    process.argv = ['node', 'index.js', '--ssh-host=mybastion'];
    expect(resolveSSHConfig()?.config.privateKeyDiscovered).toBe(true);

    process.argv = ['node', 'index.js', '--ssh-host=mybastion', '--ssh-key=/explicit/key'];
    expect(resolveSSHConfig()?.config).toMatchObject({
      privateKey: '/explicit/key',
      privateKeyDiscovered: false
    });
  });
});
