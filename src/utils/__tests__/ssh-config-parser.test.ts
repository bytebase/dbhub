import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSSHConfig, looksLikeSSHAlias, resolveSymlink, parseJumpHost, parseJumpHosts, resolveJumpHosts } from '../ssh-config-parser.js';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, realpathSync, unlinkSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

/**
 * Check if symlinks are supported on the current platform.
 * On Windows without admin rights, symlink creation will fail with EPERM.
 */
function checkSymlinkSupport(): boolean {
  const testDir = mkdtempSync(join(tmpdir(), 'symlink-check-'));
  const targetFile = join(testDir, 'target');
  const linkFile = join(testDir, 'link');

  try {
    writeFileSync(targetFile, 'test');
    symlinkSync(targetFile, linkFile);
    unlinkSync(linkFile);
    unlinkSync(targetFile);
    rmSync(testDir, { recursive: true });
    return true;
  } catch (error) {
    rmSync(testDir, { recursive: true, force: true });
    const e = error as NodeJS.ErrnoException;
    return !(e.code === 'EPERM' || e.code === 'ENOTSUP');
  }
}

// Check symlink support once at module load time
const symlinksSupported = checkSymlinkSupport();

describe('SSH Config Parser', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    // Create a temporary directory for test config files
    tempDir = mkdtempSync(join(tmpdir(), 'dbhub-ssh-test-'));
    configPath = join(tempDir, 'config');
  });

  afterEach(() => {
    // Clean up temporary directory
    rmSync(tempDir, { recursive: true });
  });

  describe('parseSSHConfig', () => {
    it('should parse basic SSH config', () => {
      const configContent = `
Host myserver
  HostName 192.168.1.100
  User johndoe
  Port 2222
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('myserver', configPath);
      expect(result).toEqual({
        host: '192.168.1.100',
        username: 'johndoe',
        port: 2222
      });
    });

    it('should handle identity file', () => {
      const identityPath = join(tempDir, 'id_rsa');
      writeFileSync(identityPath, 'fake-key-content');

      const configContent = `
Host dev-server
  HostName dev.example.com
  User developer
  IdentityFile ${identityPath}
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('dev-server', configPath);
      expect(result).toEqual({
        host: 'dev.example.com',
        username: 'developer',
        // Path is resolved to real path (e.g., on macOS /var -> /private/var)
        privateKey: realpathSync(identityPath)
      });
    });

    it('should handle multiple identity files and use the first one', () => {
      const identityPath1 = join(tempDir, 'id_rsa');
      const identityPath2 = join(tempDir, 'id_ed25519');
      writeFileSync(identityPath1, 'fake-key-1');
      writeFileSync(identityPath2, 'fake-key-2');

      const configContent = `
Host multi-key
  HostName multi.example.com
  User multiuser
  IdentityFile ${identityPath1}
  IdentityFile ${identityPath2}
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('multi-key', configPath);
      // Path is resolved to real path (e.g., on macOS /var -> /private/var)
      expect(result?.privateKey).toBe(realpathSync(identityPath1));
    });

    it('should handle wildcard patterns', () => {
      const configContent = `
Host *.example.com
  User defaultuser
  Port 2222

Host prod.example.com
  HostName 10.0.0.100
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('prod.example.com', configPath);
      expect(result).toEqual({
        host: '10.0.0.100',
        username: 'defaultuser',
        port: 2222
      });
    });

    it('should use host alias as hostname if HostName not specified', () => {
      const configContent = `
Host myalias
  User testuser
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('myalias', configPath);
      expect(result).toEqual({
        host: 'myalias',
        username: 'testuser'
      });
    });

    it('should return null for non-existent host', () => {
      const configContent = `
Host myserver
  HostName 192.168.1.100
  User johndoe
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('nonexistent', configPath);
      expect(result).toBeNull();
    });

    it('should return null if config file does not exist', () => {
      const result = parseSSHConfig('myserver', '/non/existent/path');
      expect(result).toBeNull();
    });

    it('should return null if required fields are missing', () => {
      const configContent = `
Host incomplete
  HostName 192.168.1.100
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('incomplete', configPath);
      expect(result).toBeNull();
    });

    it('should handle tilde expansion in identity file', () => {
      // Mock a key file that would exist in home directory
      const mockKeyPath = join(tempDir, 'mock_id_rsa');
      writeFileSync(mockKeyPath, 'fake-key');

      const configContent = `
Host tilde-test
  HostName tilde.example.com
  User tildeuser
  IdentityFile ${mockKeyPath}
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('tilde-test', configPath);
      // Path is resolved to real path (e.g., on macOS /var -> /private/var)
      expect(result?.privateKey).toBe(realpathSync(mockKeyPath));
    });
  });

  describe('looksLikeSSHAlias', () => {
    it('should return true for simple hostnames', () => {
      expect(looksLikeSSHAlias('myserver')).toBe(true);
      expect(looksLikeSSHAlias('dev-box')).toBe(true);
      expect(looksLikeSSHAlias('prod_server')).toBe(true);
    });

    it('should return false for domains', () => {
      expect(looksLikeSSHAlias('example.com')).toBe(false);
      expect(looksLikeSSHAlias('sub.example.com')).toBe(false);
      expect(looksLikeSSHAlias('my.local.dev')).toBe(false);
    });

    it('should return false for IP addresses', () => {
      expect(looksLikeSSHAlias('192.168.1.1')).toBe(false);
      expect(looksLikeSSHAlias('10.0.0.1')).toBe(false);
      expect(looksLikeSSHAlias('::1')).toBe(false);
      expect(looksLikeSSHAlias('2001:db8::1')).toBe(false);
    });
  });

  describe('resolveSymlink', () => {
    it('should return the same path for regular files', () => {
      const filePath = join(tempDir, 'regular_file');
      writeFileSync(filePath, 'content');

      const result = resolveSymlink(filePath);
      expect(result).toBe(realpathSync(filePath));
    });

    it.skipIf(!symlinksSupported)('should resolve symlinks to files', () => {
      const targetPath = join(tempDir, 'target_file');
      const linkPath = join(tempDir, 'link_to_file');
      writeFileSync(targetPath, 'content');

      symlinkSync(targetPath, linkPath);
      const result = resolveSymlink(linkPath);
      expect(result).toBe(realpathSync(targetPath));
    });

    it.skipIf(!symlinksSupported)('should resolve symlinks to directories', () => {
      const targetDir = join(tempDir, 'target_dir');
      const linkDir = join(tempDir, 'link_to_dir');
      mkdirSync(targetDir);

      symlinkSync(targetDir, linkDir, 'dir');
      const result = resolveSymlink(linkDir);
      expect(result).toBe(realpathSync(targetDir));
    });

    it('should handle tilde expansion', () => {
      const result = resolveSymlink('~/some/path');
      expect(result.startsWith(homedir())).toBe(true);
      expect(result).toContain('some');
      expect(result).toContain('path');
    });

    it('should return expanded path for non-existent files', () => {
      const result = resolveSymlink('~/non/existent/path');
      expect(result.startsWith(homedir())).toBe(true);
    });

    it.skipIf(!symlinksSupported)('should handle files within symlinked directories', () => {
      const targetDir = join(tempDir, 'ssh_target');
      const linkDir = join(tempDir, 'ssh_link');
      mkdirSync(targetDir);

      const configFile = join(targetDir, 'config');
      writeFileSync(configFile, 'Host test\n  User testuser\n');

      symlinkSync(targetDir, linkDir, 'dir');
      const linkedConfigPath = join(linkDir, 'config');
      const result = resolveSymlink(linkedConfigPath);
      expect(result).toBe(realpathSync(configFile));
    });
  });

  describe.skipIf(!symlinksSupported)('parseSSHConfig with symlinks', () => {
    it('should parse config from symlinked directory', () => {
      const targetDir = join(tempDir, 'ssh_real');
      const linkDir = join(tempDir, 'ssh_symlink');
      mkdirSync(targetDir);

      const configContent = `
Host symlink-test
  HostName symlink.example.com
  User symlinkuser
`;
      writeFileSync(join(targetDir, 'config'), configContent);

      symlinkSync(targetDir, linkDir, 'dir');
      const linkedConfigPath = join(linkDir, 'config');
      const result = parseSSHConfig('symlink-test', linkedConfigPath);
      expect(result).toEqual({
        host: 'symlink.example.com',
        username: 'symlinkuser'
      });
    });

    it('should handle identity file in symlinked directory', () => {
      const targetDir = join(tempDir, 'ssh_keys_real');
      const linkDir = join(tempDir, 'ssh_keys_link');
      mkdirSync(targetDir);

      const keyPath = join(targetDir, 'id_rsa');
      writeFileSync(keyPath, 'fake-key-content');

      symlinkSync(targetDir, linkDir, 'dir');
      const linkedKeyPath = join(linkDir, 'id_rsa');

      const configContent = `
Host key-symlink-test
  HostName keytest.example.com
  User keyuser
  IdentityFile ${linkedKeyPath}
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('key-symlink-test', configPath);
      expect(result?.host).toBe('keytest.example.com');
      expect(result?.username).toBe('keyuser');
      // The private key path should be resolved to the real path
      expect(result?.privateKey).toBe(realpathSync(keyPath));
    });
  });

  describe('parseSSHConfig with ProxyJump', () => {
    it('should extract ProxyJump from SSH config', () => {
      const configContent = `
Host target-with-jump
  HostName 10.0.0.5
  User admin
  ProxyJump bastion.example.com
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('target-with-jump', configPath);
      expect(result?.host).toBe('10.0.0.5');
      expect(result?.username).toBe('admin');
      expect(result?.proxyJump).toBe('bastion.example.com');
    });

    it('should extract multi-hop ProxyJump from SSH config', () => {
      const configContent = `
Host multi-jump-target
  HostName 10.0.0.6
  User root
  ProxyJump jump1.example.com,admin@jump2.example.com:2222
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('multi-jump-target', configPath);
      expect(result?.host).toBe('10.0.0.6');
      expect(result?.username).toBe('root');
      expect(result?.proxyJump).toBe('jump1.example.com,admin@jump2.example.com:2222');
    });
  });
});

describe('parseJumpHost', () => {
  it('should parse simple hostname', () => {
    const result = parseJumpHost('bastion.example.com');
    expect(result).toEqual({
      host: 'bastion.example.com',
      port: 22,
      username: undefined
    });
  });

  it('should parse hostname with port', () => {
    const result = parseJumpHost('bastion.example.com:2222');
    expect(result).toEqual({
      host: 'bastion.example.com',
      port: 2222,
      username: undefined
    });
  });

  it('should parse hostname with username', () => {
    const result = parseJumpHost('admin@bastion.example.com');
    expect(result).toEqual({
      host: 'bastion.example.com',
      port: 22,
      username: 'admin'
    });
  });

  it('should parse hostname with username and port', () => {
    const result = parseJumpHost('admin@bastion.example.com:2222');
    expect(result).toEqual({
      host: 'bastion.example.com',
      port: 2222,
      username: 'admin'
    });
  });

  it('should handle IPv4 addresses', () => {
    const result = parseJumpHost('192.168.1.100:22');
    expect(result).toEqual({
      host: '192.168.1.100',
      port: 22,
      username: undefined
    });
  });

  it('should handle IPv6 addresses in brackets', () => {
    const result = parseJumpHost('[::1]:22');
    expect(result).toEqual({
      host: '::1',
      port: 22,
      username: undefined
    });
  });

  it('should handle IPv6 with username', () => {
    const result = parseJumpHost('admin@[2001:db8::1]:2222');
    expect(result).toEqual({
      host: '2001:db8::1',
      port: 2222,
      username: 'admin'
    });
  });

  it('should trim whitespace', () => {
    const result = parseJumpHost('  admin@bastion.example.com:2222  ');
    expect(result).toEqual({
      host: 'bastion.example.com',
      port: 2222,
      username: 'admin'
    });
  });

  it('should throw error for empty string', () => {
    expect(() => parseJumpHost('')).toThrow('Jump host string cannot be empty');
    expect(() => parseJumpHost('   ')).toThrow('Jump host string cannot be empty');
  });

  it('should throw error for empty host (user@:port)', () => {
    expect(() => parseJumpHost('user@:22')).toThrow('host cannot be empty');
  });

  it('should throw error for only @ symbol', () => {
    expect(() => parseJumpHost('@')).toThrow('host cannot be empty');
  });

  it('should throw error for only port (:22)', () => {
    expect(() => parseJumpHost(':22')).toThrow('host cannot be empty');
  });

  it('should handle @host without username (treats as host)', () => {
    const result = parseJumpHost('@bastion.example.com');
    expect(result).toEqual({
      host: 'bastion.example.com',
      port: 22,
      username: undefined
    });
  });

  it('should throw error for invalid port numbers', () => {
    // Port 0 is invalid
    expect(() => parseJumpHost('host:0')).toThrow('Invalid port number');
    expect(() => parseJumpHost('host:0')).toThrow('port must be between 1 and 65535');

    // Port > 65535 is invalid
    expect(() => parseJumpHost('host:99999')).toThrow('Invalid port number');
    expect(() => parseJumpHost('host:99999')).toThrow('port must be between 1 and 65535');

    // Valid port should work
    const result = parseJumpHost('host:65535');
    expect(result.port).toBe(65535);
  });

  it('should throw error for malformed IPv6 (missing closing bracket)', () => {
    expect(() => parseJumpHost('[::1')).toThrow('missing closing bracket');
    expect(() => parseJumpHost('user@[2001:db8::1')).toThrow('missing closing bracket');
  });

  it('should throw error for invalid port numbers in IPv6 addresses', () => {
    // Port 0 is invalid for IPv6
    expect(() => parseJumpHost('[::1]:0')).toThrow('Invalid port number');
    expect(() => parseJumpHost('[::1]:0')).toThrow('port must be between 1 and 65535');

    // Port > 65535 is invalid for IPv6
    expect(() => parseJumpHost('[2001:db8::1]:99999')).toThrow('Invalid port number');
    expect(() => parseJumpHost('[2001:db8::1]:99999')).toThrow('port must be between 1 and 65535');

    // Valid port should work for IPv6
    const result = parseJumpHost('[::1]:8080');
    expect(result.port).toBe(8080);
  });
});

describe('parseJumpHosts', () => {
  it('should parse single jump host', () => {
    const result = parseJumpHosts('bastion.example.com');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      host: 'bastion.example.com',
      port: 22,
      username: undefined
    });
  });

  it('should parse multiple jump hosts', () => {
    const result = parseJumpHosts('jump1.example.com,admin@jump2.example.com:2222');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      host: 'jump1.example.com',
      port: 22,
      username: undefined
    });
    expect(result[1]).toEqual({
      host: 'jump2.example.com',
      port: 2222,
      username: 'admin'
    });
  });

  it('should handle whitespace around commas', () => {
    const result = parseJumpHosts('jump1.example.com , jump2.example.com');
    expect(result).toHaveLength(2);
    expect(result[0].host).toBe('jump1.example.com');
    expect(result[1].host).toBe('jump2.example.com');
  });

  it('should return empty array for empty string', () => {
    expect(parseJumpHosts('')).toEqual([]);
  });

  it('should return empty array for "none"', () => {
    expect(parseJumpHosts('none')).toEqual([]);
    expect(parseJumpHosts('NONE')).toEqual([]);
  });

  it('should filter out empty segments', () => {
    const result = parseJumpHosts('jump1.example.com,,jump2.example.com');
    expect(result).toHaveLength(2);
  });

  it('should parse complex multi-hop chain', () => {
    const result = parseJumpHosts('bastion.company.com,admin@internal.company.com:2222,root@10.0.0.1');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ host: 'bastion.company.com', port: 22, username: undefined });
    expect(result[1]).toEqual({ host: 'internal.company.com', port: 2222, username: 'admin' });
    expect(result[2]).toEqual({ host: '10.0.0.1', port: 22, username: 'root' });
  });

  describe('resolveJumpHosts', () => {
    let tempDir: string;
    let configPath: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'dbhub-resolvejump-'));
      configPath = join(tempDir, 'config');
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("resolves a ProxyJump alias to the bastion's real host/user/port/key (issue #347)", () => {
      const keyPath = join(tempDir, 'bastion_key');
      writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\n');
      writeFileSync(configPath, `
Host mybastion
  HostName bastion.example.com
  User ubuntu
  Port 2200
  IdentityFile ${keyPath}

Host target-with-jump
  HostName 10.0.0.5
  User admin
  ProxyJump mybastion
`);
      const hops = resolveJumpHosts('mybastion', configPath);
      expect(hops).toHaveLength(1);
      expect(hops[0].host).toBe('bastion.example.com');
      expect(hops[0].port).toBe(2200);
      expect(hops[0].username).toBe('ubuntu');
      expect(hops[0].privateKey).toBe(realpathSync(keyPath));
    });

    it('resolves a jump alias that has no User (username inherited from target)', () => {
      const keyPath = join(tempDir, 'bastion_key');
      writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\n');
      writeFileSync(configPath, `
Host bastion
  HostName bastion.example.com
  Port 2200
  IdentityFile ${keyPath}
`);
      const hops = resolveJumpHosts('bastion', configPath);
      expect(hops).toHaveLength(1);
      expect(hops[0].host).toBe('bastion.example.com');
      expect(hops[0].port).toBe(2200);
      expect(hops[0].privateKey).toBe(realpathSync(keyPath));
      // No User in the stanza → username left undefined so the tunnel inherits the target's.
      expect(hops[0].username).toBeUndefined();
    });

    it('expands nested ProxyJump aliases in connection order (x -> a -> b)', () => {
      writeFileSync(configPath, `
Host x
  HostName x.example.com
  User xu
Host a
  HostName a.example.com
  User au
  ProxyJump x
Host b
  HostName b.example.com
  User bu
`);
      const hops = resolveJumpHosts('a,b', configPath);
      expect(hops.map((h) => h.host)).toEqual(['x.example.com', 'a.example.com', 'b.example.com']);
    });

    it('throws on a ProxyJump cycle', () => {
      writeFileSync(configPath, `
Host a
  HostName a.example.com
  User au
  ProxyJump b
Host b
  HostName b.example.com
  User bu
  ProxyJump a
`);
      expect(() => resolveJumpHosts('a', configPath)).toThrow(/cycle/i);
    });

    it('passes through literal (non-alias) jump hosts unchanged', () => {
      writeFileSync(configPath, `Host unused\n  HostName u.example.com\n  User uu\n`);
      const hops = resolveJumpHosts('bastion.example.com:2222', configPath);
      expect(hops).toEqual([{ host: 'bastion.example.com', port: 2222, username: undefined }]);
    });

    it('lets an explicit :port on the token override the config Port (incl. :22)', () => {
      writeFileSync(configPath, `
Host mybastion
  HostName bastion.example.com
  User ubuntu
  Port 2200
`);
      // No port on the token → use the alias's Port.
      expect(resolveJumpHosts('mybastion', configPath)[0].port).toBe(2200);
      // Explicit port on the token wins — including an explicit :22.
      expect(resolveJumpHosts('mybastion:2022', configPath)[0].port).toBe(2022);
      expect(resolveJumpHosts('mybastion:22', configPath)[0].port).toBe(22);
    });

    it('lets an explicit user@ on the token override the config User', () => {
      writeFileSync(configPath, `
Host mybastion
  HostName bastion.example.com
  User ubuntu
`);
      const hops = resolveJumpHosts('admin@mybastion', configPath);
      expect(hops[0].host).toBe('bastion.example.com');
      expect(hops[0].username).toBe('admin');
    });
  });
});
