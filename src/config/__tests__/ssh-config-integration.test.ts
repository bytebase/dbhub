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
});