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

// Point HOME (and USERPROFILE on Windows) at an empty fake home directory for
// every test in this file: parseSSHConfig falls back to scanning ~/.ssh/id_*
// when a host has no IdentityFile, so with the real home the results depend on
// whatever keys exist on the developer's machine. os.homedir() reads these env
// vars, so no module mocking is needed. (vi.spyOn(os, 'homedir') does NOT work
// here — ssh-config-parser.ts binds `homedir` via a named import, which the
// namespace spy cannot intercept.)
let fakeHome: string;
let savedHome: { HOME?: string; USERPROFILE?: string };

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dbhub-fake-home-'));
  savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(() => {
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    if (savedHome[key] === undefined) delete process.env[key];
    else process.env[key] = savedHome[key];
  }
  rmSync(fakeHome, { recursive: true, force: true });
});

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
        privateKey: realpathSync(identityPath),
        // Marked so the tunnel can tell it from an explicitly configured key
        privateKeyDiscovered: true
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
      // Key lives in the (fake) home directory and is referenced with ~/
      const mockKeyPath = join(fakeHome, 'mock_id_rsa');
      writeFileSync(mockKeyPath, 'fake-key');

      const configContent = `
Host tilde-test
  HostName tilde.example.com
  User tildeuser
  IdentityFile ~/mock_id_rsa
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('tilde-test', configPath);
      // Path is resolved to real path (e.g., on macOS /var -> /private/var)
      expect(result?.privateKey).toBe(realpathSync(mockKeyPath));
    });

    it('should fall back to a default ~/.ssh key when no IdentityFile is specified', () => {
      mkdirSync(join(fakeHome, '.ssh'));
      const defaultKeyPath = join(fakeHome, '.ssh', 'id_ed25519');
      writeFileSync(defaultKeyPath, 'fake-default-key');

      const configContent = `
Host default-key-test
  HostName default.example.com
  User defaultkeyuser
`;
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('default-key-test', configPath);
      expect(result?.privateKey).toBe(realpathSync(defaultKeyPath));
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

    it('should expand a tilde path even when the file does not exist', () => {
      const result = resolveSymlink('~/non/existent/path');
      expect(result.startsWith(homedir())).toBe(true);
      expect(result).toContain('non');
      expect(result).toContain('path');
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
  it.each([
    ['bastion.example.com', 'bastion.example.com', 22, undefined],
    ['bastion.example.com:2222', 'bastion.example.com', 2222, undefined],
    ['admin@bastion.example.com', 'bastion.example.com', 22, 'admin'],
    ['admin@bastion.example.com:2222', 'bastion.example.com', 2222, 'admin'],
    ['192.168.1.100:22', '192.168.1.100', 22, undefined],
    ['[::1]:22', '::1', 22, undefined],
    ['admin@[2001:db8::1]:2222', '2001:db8::1', 2222, 'admin'],
    // Surrounding whitespace is trimmed
    ['  admin@bastion.example.com:2222  ', 'bastion.example.com', 2222, 'admin'],
    // A leading @ without a username is treated as part of the host form, not a user
    ['@bastion.example.com', 'bastion.example.com', 22, undefined],
    // Upper bound of the valid port range, hostname and IPv6
    ['host:65535', 'host', 65535, undefined],
    ['[::1]:8080', '::1', 8080, undefined],
  ])('should parse %j', (input, host, port, username) => {
    expect(parseJumpHost(input)).toEqual({ host, port, username });
  });

  it.each([
    ['', /Jump host string cannot be empty/],
    ['   ', /Jump host string cannot be empty/],
    ['user@:22', /host cannot be empty/],
    ['@', /host cannot be empty/],
    [':22', /host cannot be empty/],
    ['host:0', /Invalid port number.*port must be between 1 and 65535/],
    ['host:99999', /Invalid port number.*port must be between 1 and 65535/],
    ['[::1]:0', /Invalid port number.*port must be between 1 and 65535/],
    ['[2001:db8::1]:99999', /Invalid port number.*port must be between 1 and 65535/],
    ['[::1', /missing closing bracket/],
    ['user@[2001:db8::1', /missing closing bracket/],
  ])('should throw for %j', (input, message) => {
    expect(() => parseJumpHost(input)).toThrow(message);
  });
});

describe('parseJumpHosts', () => {
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

  it('resolves a jump alias defining only Port/IdentityFile (HostName falls back to the alias)', () => {
    const keyPath = join(tempDir, 'bastion_key');
    writeFileSync(keyPath, '-----BEGIN OPENSSH PRIVATE KEY-----\n');
    writeFileSync(configPath, `
Host bastion
Port 2200
IdentityFile ${keyPath}
`);
    const hops = resolveJumpHosts('bastion', configPath);
    expect(hops).toHaveLength(1);
    // No HostName → OpenSSH uses the alias itself as the hostname.
    expect(hops[0].host).toBe('bastion');
    expect(hops[0].port).toBe(2200);
    expect(hops[0].privateKey).toBe(realpathSync(keyPath));
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
