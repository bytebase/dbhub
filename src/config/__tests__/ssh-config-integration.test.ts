import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveSSHConfig } from '../env.js';
import { homedir } from 'os';
import { join } from 'path';
import * as sshConfigParser from '../../utils/ssh-config-parser.js';

// Mock the ssh-config-parser module
vi.mock('../../utils/ssh-config-parser.js', () => ({
  parseSSHConfig: vi.fn(),
  looksLikeSSHAlias: vi.fn(),
  getDefaultSSHConfigPath: vi.fn(() => join(homedir(), '.ssh', 'config'))
}));

describe('SSH Config Integration', () => {
  let originalArgs: string[];
  
  beforeEach(() => {
    // Save original values
    originalArgs = process.argv;

    // Clear mocks
    vi.clearAllMocks();

    // Clear any SSH environment variables so values exported in the
    // developer's shell can't leak into the first test
    delete process.env.SSH_HOST;
    delete process.env.SSH_USER;
    delete process.env.SSH_PORT;
    delete process.env.SSH_KEY;
    delete process.env.SSH_PASSWORD;
    delete process.env.SSH_AUTH_SOCK;
  });

  afterEach(() => {
    // Restore original values
    process.argv = originalArgs;
    
    // Clear any environment variables
    delete process.env.SSH_HOST;
    delete process.env.SSH_USER;
    delete process.env.SSH_PORT;
    delete process.env.SSH_KEY;
    delete process.env.SSH_PASSWORD;
    delete process.env.SSH_AUTH_SOCK;
  });
  
  it('should resolve SSH config from host alias', () => {
    // Mock the SSH config parser
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(true);
    vi.mocked(sshConfigParser.parseSSHConfig).mockImplementation((hostAlias: string, configPath: string) => ({
      host: 'bastion.example.com',
      username: 'ubuntu',
      port: 2222,
      privateKey: '/home/user/.ssh/id_rsa'
    }));
    
    // Simulate command line args
    process.argv = ['node', 'index.js', '--ssh-host=mybastion'];
    
    const result = resolveSSHConfig();
    
    expect(result).not.toBeNull();
    expect(result?.config).toMatchObject({
      host: 'bastion.example.com',
      username: 'ubuntu',
      port: 2222,
      privateKey: '/home/user/.ssh/id_rsa'
    });
    expect(result?.source).toContain('SSH config for host \'mybastion\'');
  });
  
  it('should allow command line to override SSH config values', () => {
    // Mock the SSH config parser
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(true);
    vi.mocked(sshConfigParser.parseSSHConfig).mockImplementation((hostAlias: string, configPath: string) => ({
      host: 'bastion.example.com',
      username: 'ubuntu',
      port: 2222,
      privateKey: '/home/user/.ssh/id_rsa'
    }));
    
    // Simulate command line args with override
    process.argv = ['node', 'index.js', '--ssh-host=mybastion', '--ssh-user=override-user'];
    
    const result = resolveSSHConfig();
    
    expect(result).not.toBeNull();
    expect(result?.config).toMatchObject({
      host: 'bastion.example.com',
      username: 'override-user', // Command line overrides config
      port: 2222,
      privateKey: '/home/user/.ssh/id_rsa'
    });
  });
  
  it('should work with environment variables', () => {
    // Mock the SSH config parser
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(true);
    vi.mocked(sshConfigParser.parseSSHConfig).mockImplementation((hostAlias: string, configPath: string) => ({
      host: 'bastion.example.com',
      username: 'ubuntu',
      port: 2222,
      privateKey: '/home/user/.ssh/id_rsa'
    }));
    
    process.env.SSH_HOST = 'mybastion';
    
    const result = resolveSSHConfig();
    
    expect(result).not.toBeNull();
    expect(result?.config).toMatchObject({
      host: 'bastion.example.com',
      username: 'ubuntu',
      port: 2222,
      privateKey: '/home/user/.ssh/id_rsa'
    });
  });
  
  it('should not use SSH config for direct hostnames', () => {
    // Mock the SSH config parser
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(false);
    
    process.argv = ['node', 'index.js', '--ssh-host=direct.example.com', '--ssh-user=myuser', '--ssh-password=mypass'];
    
    const result = resolveSSHConfig();
    
    expect(result).not.toBeNull();
    expect(result?.config).toMatchObject({
      host: 'direct.example.com',
      username: 'myuser',
      password: 'mypass'
    });
    expect(result?.source).not.toContain('SSH config');
    expect(sshConfigParser.parseSSHConfig).not.toHaveBeenCalled();
  });
  
  it('should require SSH user when only host is provided', () => {
    // Mock the SSH config parser to return null (no config found)
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(true);
    vi.mocked(sshConfigParser.parseSSHConfig).mockImplementation((hostAlias: string, configPath: string) => null);
    
    process.argv = ['node', 'index.js', '--ssh-host=unknown-host'];
    
    expect(() => resolveSSHConfig()).toThrow('SSH tunnel configuration requires at least --ssh-host and --ssh-user');
  });

  it('should require an auth method when no password, key, or agent is available', () => {
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(false);

    process.argv = ['node', 'index.js', '--ssh-host=direct.example.com', '--ssh-user=myuser'];

    expect(() => resolveSSHConfig()).toThrow(
      'SSH tunnel configuration requires either --ssh-password or --ssh-key (or an SSH agent via --ssh-agent or SSH_AUTH_SOCK) for authentication'
    );
  });

  it('should accept an SSH agent as the only auth method', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(false);

    process.argv = ['node', 'index.js', '--ssh-host=direct.example.com', '--ssh-user=myuser'];

    const result = resolveSSHConfig();

    expect(result?.config).toMatchObject({ host: 'direct.example.com', username: 'myuser' });
    expect(result?.config.password).toBeUndefined();
    expect(result?.config.privateKey).toBeUndefined();
  });

  it('should accept --ssh-agent as the only auth method', () => {
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(false);

    process.argv = [
      'node', 'index.js', '--ssh-host=direct.example.com', '--ssh-user=myuser', '--ssh-agent=~/agent.sock'
    ];

    const result = resolveSSHConfig();

    expect(result?.config.agent).toBe(join(process.env.HOME || '', 'agent.sock'));
    expect(result?.source).toContain('ssh-agent from command line');
  });

  it('should exit when --ssh-agent is given without a value', () => {
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(false);
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
    vi.mocked(sshConfigParser.looksLikeSSHAlias).mockReturnValue(true);
    vi.mocked(sshConfigParser.parseSSHConfig).mockImplementation(() => ({
      host: 'bastion.example.com',
      username: 'ubuntu',
      privateKey: '/home/user/.ssh/id_rsa',
      privateKeyDiscovered: true
    }));

    process.argv = ['node', 'index.js', '--ssh-host=mybastion'];
    expect(resolveSSHConfig()?.config.privateKeyDiscovered).toBe(true);

    process.argv = ['node', 'index.js', '--ssh-host=mybastion', '--ssh-key=/explicit/key'];
    expect(resolveSSHConfig()?.config).toMatchObject({
      privateKey: '/explicit/key',
      privateKeyDiscovered: false
    });
  });
});