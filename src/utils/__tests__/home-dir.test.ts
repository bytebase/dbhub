import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import { expandHomeDir } from '../home-dir.js';

describe('expandHomeDir', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('expands a leading ~/ to the home directory', () => {
    expect(expandHomeDir('~/.ssh/id_rsa')).toBe(path.join(os.homedir(), '.ssh', 'id_rsa'));
  });

  it.each(['/etc/ssl/ca.pem', './relative/ca.pem', 'relative/ca.pem', '~', '~user/key', 'a/~/b', ''])(
    'leaves %j unchanged',
    (filePath) => {
      expect(expandHomeDir(filePath)).toBe(filePath);
    }
  );

  it('reads the home directory when called, not when the module was loaded', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/somewhere/else');
    expect(expandHomeDir('~/key')).toBe(path.join('/somewhere/else', 'key'));
  });

  it('does not depend on $HOME being set', () => {
    // On Windows HOME is usually unset; joining with "" would turn ~/.ssh/id_rsa
    // into the relative path .ssh/id_rsa.
    vi.spyOn(os, 'homedir').mockReturnValue('/home/someone');
    vi.stubEnv('HOME', '');
    expect(expandHomeDir('~/.ssh/id_rsa')).toBe(path.join('/home/someone', '.ssh', 'id_rsa'));
  });
});
