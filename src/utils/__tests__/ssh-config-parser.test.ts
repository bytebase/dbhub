import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSSHConfig, looksLikeSSHAlias, resolveSymlink } from '../ssh-config-parser.js';
<<<<<<< HEAD
<<<<<<< HEAD
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, realpathSync, unlinkSync } from 'fs';
=======
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, realpathSync } from 'fs';
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, realpathSync, unlinkSync } from 'fs';
>>>>>>> 3a1c62d (chore: address comment)
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

<<<<<<< HEAD
<<<<<<< HEAD
    it.skipIf(!symlinksSupported)('should resolve symlinks to files', () => {
=======
    it('should resolve symlinks to files', () => {
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
    it.skipIf(!symlinksSupported)('should resolve symlinks to files', () => {
>>>>>>> 3a1c62d (chore: address comment)
      const targetPath = join(tempDir, 'target_file');
      const linkPath = join(tempDir, 'link_to_file');
      writeFileSync(targetPath, 'content');

<<<<<<< HEAD
<<<<<<< HEAD
      symlinkSync(targetPath, linkPath);
      const result = resolveSymlink(linkPath);
      expect(result).toBe(realpathSync(targetPath));
    });

    it.skipIf(!symlinksSupported)('should resolve symlinks to directories', () => {
=======
      try {
        symlinkSync(targetPath, linkPath);
        const result = resolveSymlink(linkPath);
        expect(result).toBe(realpathSync(targetPath));
      } catch (error) {
        // Skip test if symlinks are not supported (e.g., Windows without admin rights)
        const e = error as NodeJS.ErrnoException;
        if (e.code === 'EPERM' || e.code === 'ENOTSUP') {
          console.log('Symlink creation not supported, skipping test');
          return;
        }
        throw error;
      }
    });

    it('should resolve symlinks to directories', () => {
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
      symlinkSync(targetPath, linkPath);
      const result = resolveSymlink(linkPath);
      expect(result).toBe(realpathSync(targetPath));
    });

    it.skipIf(!symlinksSupported)('should resolve symlinks to directories', () => {
>>>>>>> 3a1c62d (chore: address comment)
      const targetDir = join(tempDir, 'target_dir');
      const linkDir = join(tempDir, 'link_to_dir');
      mkdirSync(targetDir);

<<<<<<< HEAD
<<<<<<< HEAD
      symlinkSync(targetDir, linkDir, 'dir');
      const result = resolveSymlink(linkDir);
      expect(result).toBe(realpathSync(targetDir));
=======
      try {
        symlinkSync(targetDir, linkDir, 'dir');
        const result = resolveSymlink(linkDir);
        expect(result).toBe(realpathSync(targetDir));
      } catch (error) {
        // Skip test if symlinks are not supported
        const e = error as NodeJS.ErrnoException;
        if (e.code === 'EPERM' || e.code === 'ENOTSUP') {
          console.log('Symlink creation not supported, skipping test');
          return;
        }
        throw error;
      }
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
      symlinkSync(targetDir, linkDir, 'dir');
      const result = resolveSymlink(linkDir);
      expect(result).toBe(realpathSync(targetDir));
>>>>>>> 3a1c62d (chore: address comment)
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

<<<<<<< HEAD
<<<<<<< HEAD
    it.skipIf(!symlinksSupported)('should handle files within symlinked directories', () => {
=======
    it('should handle files within symlinked directories', () => {
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
    it.skipIf(!symlinksSupported)('should handle files within symlinked directories', () => {
>>>>>>> 3a1c62d (chore: address comment)
      const targetDir = join(tempDir, 'ssh_target');
      const linkDir = join(tempDir, 'ssh_link');
      mkdirSync(targetDir);

      const configFile = join(targetDir, 'config');
      writeFileSync(configFile, 'Host test\n  User testuser\n');

<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 3a1c62d (chore: address comment)
      symlinkSync(targetDir, linkDir, 'dir');
      const linkedConfigPath = join(linkDir, 'config');
      const result = resolveSymlink(linkedConfigPath);
      expect(result).toBe(realpathSync(configFile));
<<<<<<< HEAD
    });
  });

  describe.skipIf(!symlinksSupported)('parseSSHConfig with symlinks', () => {
=======
      try {
        symlinkSync(targetDir, linkDir, 'dir');
        const linkedConfigPath = join(linkDir, 'config');
        const result = resolveSymlink(linkedConfigPath);
        expect(result).toBe(realpathSync(configFile));
      } catch (error) {
        // Skip test if symlinks are not supported
        const e = error as NodeJS.ErrnoException;
        if (e.code === 'EPERM' || e.code === 'ENOTSUP') {
          console.log('Symlink creation not supported, skipping test');
          return;
        }
        throw error;
      }
    });
  });

  describe('parseSSHConfig with symlinks', () => {
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
    });
  });

  describe.skipIf(!symlinksSupported)('parseSSHConfig with symlinks', () => {
>>>>>>> 3a1c62d (chore: address comment)
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

<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 3a1c62d (chore: address comment)
      symlinkSync(targetDir, linkDir, 'dir');
      const linkedConfigPath = join(linkDir, 'config');
      const result = parseSSHConfig('symlink-test', linkedConfigPath);
      expect(result).toEqual({
        host: 'symlink.example.com',
        username: 'symlinkuser'
      });
<<<<<<< HEAD
=======
      try {
        symlinkSync(targetDir, linkDir, 'dir');
        const linkedConfigPath = join(linkDir, 'config');
        const result = parseSSHConfig('symlink-test', linkedConfigPath);
        expect(result).toEqual({
          host: 'symlink.example.com',
          username: 'symlinkuser'
        });
      } catch (error) {
        // Skip test if symlinks are not supported
        const e = error as NodeJS.ErrnoException;
        if (e.code === 'EPERM' || e.code === 'ENOTSUP') {
          console.log('Symlink creation not supported, skipping test');
          return;
        }
        throw error;
      }
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
>>>>>>> 3a1c62d (chore: address comment)
    });

    it('should handle identity file in symlinked directory', () => {
      const targetDir = join(tempDir, 'ssh_keys_real');
      const linkDir = join(tempDir, 'ssh_keys_link');
      mkdirSync(targetDir);

      const keyPath = join(targetDir, 'id_rsa');
      writeFileSync(keyPath, 'fake-key-content');

<<<<<<< HEAD
<<<<<<< HEAD
      symlinkSync(targetDir, linkDir, 'dir');
      const linkedKeyPath = join(linkDir, 'id_rsa');

      const configContent = `
=======
      try {
        symlinkSync(targetDir, linkDir, 'dir');
        const linkedKeyPath = join(linkDir, 'id_rsa');

        const configContent = `
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
      symlinkSync(targetDir, linkDir, 'dir');
      const linkedKeyPath = join(linkDir, 'id_rsa');

      const configContent = `
>>>>>>> 3a1c62d (chore: address comment)
Host key-symlink-test
  HostName keytest.example.com
  User keyuser
  IdentityFile ${linkedKeyPath}
`;
<<<<<<< HEAD
<<<<<<< HEAD
      writeFileSync(configPath, configContent);

      const result = parseSSHConfig('key-symlink-test', configPath);
      expect(result?.host).toBe('keytest.example.com');
      expect(result?.username).toBe('keyuser');
      // The private key path should be resolved to the real path
      expect(result?.privateKey).toBe(realpathSync(keyPath));
    });
  });
});
=======
        writeFileSync(configPath, configContent);
=======
      writeFileSync(configPath, configContent);
>>>>>>> 3a1c62d (chore: address comment)

      const result = parseSSHConfig('key-symlink-test', configPath);
      expect(result?.host).toBe('keytest.example.com');
      expect(result?.username).toBe('keyuser');
      // The private key path should be resolved to the real path
      expect(result?.privateKey).toBe(realpathSync(keyPath));
    });
  });
});
<<<<<<< HEAD
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
>>>>>>> 3a1c62d (chore: address comment)
