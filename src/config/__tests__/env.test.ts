import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildDSNFromEnvParams, redactDSN, resolveDSN, resolveHost, resolveId } from '../env.js';
import { loadTomlConfig } from '../toml-loader.js';

// Mock toml-loader to prevent it from loading dbhub.toml during tests
vi.mock('../toml-loader.js', () => ({
  loadTomlConfig: vi.fn(() => null),
}));

// Make dotenv a no-op by default so tests never pick up a real .env/.env.local
// from the developer's working copy (loadEnvFiles also checks the package root,
// so chdir alone can't isolate it). The one test that genuinely exercises .env
// loading flips `dotenvState.passthrough` to use the real implementation.
const dotenvState = vi.hoisted(() => ({ passthrough: false }));
vi.mock('dotenv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dotenv')>();
  return {
    default: {
      ...actual.default,
      config: (options?: Parameters<typeof actual.default.config>[0]) =>
        dotenvState.passthrough ? actual.default.config(options) : { parsed: {} },
    },
  };
});

describe('Environment Configuration Tests', () => {
  // Store original env values to restore after tests
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant environment variables before each test
    delete process.env.DB_TYPE;
    delete process.env.DB_HOST;
    delete process.env.DB_PORT;
    delete process.env.DB_USER;
    delete process.env.DB_PASSWORD;
    delete process.env.DB_NAME;
    delete process.env.DSN;
    delete process.env.ID;
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('buildDSNFromEnvParams', () => {
    it('should build PostgreSQL DSN with all parameters', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      process.env.DB_PORT = '5432';
      process.env.DB_USER = 'testuser';
      process.env.DB_PASSWORD = 'testpass';
      process.env.DB_NAME = 'testdb';

      const result = buildDSNFromEnvParams();

      expect(result).toEqual({
        dsn: 'postgres://testuser:testpass@localhost:5432/testdb',
        source: 'individual environment variables'
      });
    });

    it.each([
      ['mysql', 3306],
      ['mariadb', 3306],
      ['sqlserver', 1433],
    ])('should build %s DSN with default port %i when port not specified', (type, port) => {
      process.env.DB_TYPE = type;
      process.env.DB_HOST = `${type}.example.com`;
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'mydb';

      const result = buildDSNFromEnvParams();

      expect(result).toEqual({
        dsn: `${type}://user:pass@${type}.example.com:${port}/mydb`,
        source: 'individual environment variables'
      });
    });

    it('should build SQLite DSN with only DB_TYPE and DB_NAME', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_NAME = '/path/to/database.db';

      const result = buildDSNFromEnvParams();

      expect(result).toEqual({
        dsn: 'sqlite:////path/to/database.db',
        source: 'individual environment variables'
      });
    });

    it('should handle postgresql type and normalize to postgres protocol', () => {
      process.env.DB_TYPE = 'postgresql';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';

      const result = buildDSNFromEnvParams();

      expect(result?.dsn).toBe('postgres://user:pass@localhost:5432/db');
    });

    it('should properly encode special characters in password', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'test@pass:with/special#chars&more=special';
      process.env.DB_NAME = 'db';

      const result = buildDSNFromEnvParams();

      expect(result?.dsn).toBe(
        'postgres://user:test%40pass%3Awith%2Fspecial%23chars%26more%3Dspecial@localhost:5432/db'
      );
    });

    it('should properly encode special characters in username', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user@domain.com';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';

      const result = buildDSNFromEnvParams();

      expect(result?.dsn).toBe(
        'postgres://user%40domain.com:pass@localhost:5432/db'
      );
    });

    it('should properly encode special characters in database name', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'my-db@test';

      const result = buildDSNFromEnvParams();

      expect(result?.dsn).toBe(
        'postgres://user:pass@localhost:5432/my-db%40test'
      );
    });

    it('should handle SQLite with special characters in file path', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_NAME = '/tmp/test_db@#$.db';

      const result = buildDSNFromEnvParams();

      expect(result).toEqual({
        dsn: 'sqlite:////tmp/test_db@#$.db',
        source: 'individual environment variables'
      });
    });

    it('should return null when required parameters are missing for non-SQLite databases', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      // Missing DB_USER, DB_PASSWORD, DB_NAME

      const result = buildDSNFromEnvParams();

      expect(result).toBeNull();
    });

    it('should return null when DB_TYPE is missing', () => {
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';

      const result = buildDSNFromEnvParams();

      expect(result).toBeNull();
    });

    it('should return null when SQLite is missing DB_NAME', () => {
      process.env.DB_TYPE = 'sqlite';
      // Missing DB_NAME

      const result = buildDSNFromEnvParams();

      expect(result).toBeNull();
    });

    it('should throw error for unsupported database type', () => {
      process.env.DB_TYPE = 'oracle';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';

      expect(() => buildDSNFromEnvParams()).toThrow(
        'Unsupported DB_TYPE: oracle. Supported types: postgres, postgresql, mysql, mariadb, sqlserver, sqlite'
      );
    });

    it('should use custom port when provided', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      process.env.DB_PORT = '9999';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';

      const result = buildDSNFromEnvParams();

      expect(result?.dsn).toBe('postgres://user:pass@localhost:9999/db');
    });

    it('should return null for empty password (required field)', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = '';
      process.env.DB_NAME = 'db';

      const result = buildDSNFromEnvParams();

      expect(result).toBeNull();
    });
  });

  describe('resolveDSN integration with individual parameters', () => {
    it('should use DSN when both DSN and individual parameters are provided', () => {
      process.env.DSN = 'postgres://direct:dsn@localhost:5432/directdb';
      process.env.DB_TYPE = 'mysql';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';

      const result = resolveDSN();

      expect(result).toEqual({
        dsn: 'postgres://direct:dsn@localhost:5432/directdb',
        source: 'environment variable'
      });
    });

    it('should fall back to individual parameters when DSN is not provided', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';

      const result = resolveDSN();

      expect(result).toEqual({
        dsn: 'postgres://user:pass@localhost:5432/db',
        source: 'individual environment variables'
      });
    });

    it('should return null when neither DSN nor complete individual parameters are provided', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      // Missing required parameters

      const result = resolveDSN();

      expect(result).toBeNull();
    });

    it('should handle SQLite individual parameters correctly', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_NAME = ':memory:';

      const result = resolveDSN();

      expect(result).toEqual({
        dsn: 'sqlite:///:memory:',
        source: 'individual environment variables'
      });
    });
  });

  describe('edge cases and complex scenarios', () => {
    it('should handle password with all special URL characters', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = '!@#$%^&*()+={}[]|\\:";\'<>?,./~`';
      process.env.DB_NAME = 'db';

      const result = buildDSNFromEnvParams();

      // Verify it builds without error and contains encoded characters
      expect(result).toBeTruthy();
      // Note: encodeURIComponent doesn't encode ! so it remains as !
      expect(result?.dsn).toContain('!'); // ! is not encoded
      expect(result?.dsn).toContain('%40'); // @
      expect(result?.dsn).toContain('%23'); // #
      expect(result?.dsn).toContain('%24'); // $
      expect(result?.dsn).toContain('%25'); // %
    });

    it('should handle database names with Unicode characters', () => {
      process.env.DB_TYPE = 'postgres';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'тест_база_данных'; // Cyrillic characters

      const result = buildDSNFromEnvParams();

      expect(result).toBeTruthy();
      expect(result?.dsn).toContain('%D1%82%D0%B5%D1%81%D1%82'); // Encoded Cyrillic
    });

    it('should be case insensitive for database type', () => {
      process.env.DB_TYPE = 'POSTGRES';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';

      const result = buildDSNFromEnvParams();

      expect(result?.dsn).toBe('postgres://user:pass@localhost:5432/db');
    });
  });

  describe('resolveSourceConfigs with special character passwords', () => {
    const originalArgv = process.argv;

    beforeEach(() => {
      process.argv = ['node', 'script.js'];
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('should parse DSN with special characters via SafeURL', async () => {
      // Test that command line DSN with special characters in password is parsed correctly
      // This verifies that SafeURL is used instead of native URL() constructor
      process.argv = ['node', 'script.js', '--dsn=postgres://user:my@pass:word@localhost:5432/testdb'];

      const result = await import('../env.js').then(m => m.resolveSourceConfigs());

      expect(result).not.toBeNull();
      expect(result!.sources).toHaveLength(1);
      expect(result!.sources[0].type).toBe('postgres');
      expect(result!.sources[0].dsn).toBe('postgres://user:my@pass:word@localhost:5432/testdb');
    });

    it('should not leak the password when the DSN is malformed', async () => {
      // A scheme-less DSN fails SafeURL parsing; the resulting fatal error is
      // printed to stderr, so the raw value must never be interpolated into it.
      process.argv = ['node', 'script.js', '--dsn=user:hunter2@localhost/db'];

      const { resolveSourceConfigs } = await import('../env.js');
      let message = '';
      try {
        await resolveSourceConfigs();
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/Invalid DSN format/);
      expect(message).toContain('<redacted DSN>');
      expect(message).not.toContain('hunter2');
    });
  });

  describe('redactDSN', () => {
    it('should replace the password with asterisks', () => {
      const result = redactDSN('postgres://user:hunter2@localhost:5432/db');
      expect(result).not.toContain('hunter2');
      expect(result).toMatch(/^postgres:\/\/user:\*+@localhost:5432\/db$/);
    });

    it('should redact passwords containing @ or #', () => {
      for (const password of ['p@ss', 'pa#ss', 'p@s#s@']) {
        const result = redactDSN(`postgres://user:${password}@localhost:5432/db`);
        expect(result).not.toContain(password);
        expect(result).toMatch(/^postgres:\/\/user:\*+@localhost:5432\/db$/);
      }
    });

    it('should fail closed on a scheme-less DSN', () => {
      const result = redactDSN('user:hunter2@localhost/db');
      expect(result).toBe('<redacted DSN>');
    });

    it('should leave SQLite DSNs untouched', () => {
      expect(redactDSN('sqlite:///path/to/db.sqlite')).toBe('sqlite:///path/to/db.sqlite');
    });
  });

  describe('resolveId', () => {
    it('should return null when ID is not provided', () => {
      const result = resolveId();

      expect(result).toBeNull();
    });

    it.each(['prod', 'staging-db-01', '123'])(
      'should resolve ID %j from environment variable',
      (id) => {
        process.env.ID = id;

        const result = resolveId();

        expect(result).toEqual({
          id,
          source: 'environment variable'
        });
      }
    );
  });

  describe('resolveHost', () => {
    const originalArgv = process.argv;

    beforeEach(() => {
      delete process.env.HOST;
      delete process.env.DBHUB_HOST;
      process.argv = ['node', 'script.js'];
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('defaults to 0.0.0.0 when nothing is set', () => {
      const result = resolveHost();

      expect(result).toEqual({ host: '0.0.0.0', source: 'default' });
    });

    it('reads DBHUB_HOST from the environment variable', () => {
      process.env.DBHUB_HOST = '127.0.0.1';

      const result = resolveHost();

      expect(result).toEqual({ host: '127.0.0.1', source: 'environment variable' });
    });

    it('ignores the generic HOST env var to avoid shell/CI collisions', () => {
      process.env.HOST = 'my-laptop.local';

      const result = resolveHost();

      expect(result).toEqual({ host: '0.0.0.0', source: 'default' });
    });

    it('reads --host from command line arguments (equals form)', () => {
      process.argv = ['node', 'script.js', '--host=10.0.0.5'];

      const result = resolveHost();

      expect(result).toEqual({ host: '10.0.0.5', source: 'command line argument' });
    });

    it('reads --host from command line arguments (space form)', () => {
      process.argv = ['node', 'script.js', '--host', '192.168.1.10'];

      const result = resolveHost();

      expect(result).toEqual({ host: '192.168.1.10', source: 'command line argument' });
    });

    it('prefers --host over DBHUB_HOST environment variable', () => {
      process.env.DBHUB_HOST = '0.0.0.0';
      process.argv = ['node', 'script.js', '--host=127.0.0.1'];

      const result = resolveHost();

      expect(result).toEqual({ host: '127.0.0.1', source: 'command line argument' });
    });

    it('treats empty DBHUB_HOST env var as unset and falls back to default', () => {
      process.env.DBHUB_HOST = '';

      const result = resolveHost();

      expect(result).toEqual({ host: '0.0.0.0', source: 'default' });
    });

    it('treats whitespace-only DBHUB_HOST env var as unset and falls back to default', () => {
      // Without trimming, Node's listen() would be handed "   " verbatim and
      // fail with an obscure bind error. Consistent with the `--host` flag
      // validation, treat blank-after-trim as "not set" rather than silently
      // misconfigured.
      process.env.DBHUB_HOST = '   ';

      const result = resolveHost();

      expect(result).toEqual({ host: '0.0.0.0', source: 'default' });
    });

    it('trims surrounding whitespace from DBHUB_HOST env var', () => {
      process.env.DBHUB_HOST = '  127.0.0.1  ';

      const result = resolveHost();

      expect(result).toEqual({ host: '127.0.0.1', source: 'environment variable' });
    });

    it('accepts IPv6 addresses verbatim', () => {
      process.env.DBHUB_HOST = '::1';

      const result = resolveHost();

      expect(result).toEqual({ host: '::1', source: 'environment variable' });
    });

    describe('--host requires a value', () => {
      let exitSpy: ReturnType<typeof vi.spyOn>;
      let errorSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
          throw new Error(`process.exit: ${code}`);
        }) as never);
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      });

      afterEach(() => {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      });

      it.each([
        ['--host is provided without a value', ['--host']],
        ['--host is followed by another flag', ['--host', '--port=8080']],
        ['--host= is provided with an empty value', ['--host=']],
        ['--host= is followed by another flag', ['--host=', '--port=8080']],
        // `--host= 127.0.0.1` is not the same as `--host=127.0.0.1`: the token
        // is literally the empty string. parseCommandLineArgs has already been
        // observed to bind the positional that follows to --host, silently
        // accepting what the user almost certainly did not intend.
        [
          '--host= is present even if a non-flag token follows (empty value, no concatenation)',
          ['--host=', '127.0.0.1'],
        ],
        // With an early break in the argv scan, only the first --host is
        // inspected — a later duplicate bare --host sneaks through even though
        // it has no value and the user's intent is ambiguous.
        [
          'a later bare --host appears after an earlier valid --host',
          ['--host', '127.0.0.1', '--host'],
        ],
        // Shells can pass a quoted whitespace value through to argv, e.g.
        //   --host="   "
        // The env var path already rejects this; the CLI path should match
        // so the user gets the same friendly error instead of an opaque
        // listen() failure.
        ['--host value is whitespace-only (quoted)', ['--host=   ']],
      ])('exits when %s', (_label, argv) => {
        process.argv = ['node', 'script.js', ...argv];

        expect(() => resolveHost()).toThrow('process.exit: 1');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--host requires a value'));
      });
    });

    it('passes through an explicit --host=true without erroring (node listen will reject it)', () => {
      process.argv = ['node', 'script.js', '--host=true'];

      const result = resolveHost();

      expect(result).toEqual({ host: 'true', source: 'command line argument' });
    });

    it('trims surrounding whitespace from --host CLI value', () => {
      process.argv = ['node', 'script.js', '--host=  127.0.0.1  '];

      const result = resolveHost();

      expect(result).toEqual({ host: '127.0.0.1', source: 'command line argument' });
    });
  });

  describe('resolveSourceConfigs TOML/DSN conflict', () => {
    const originalArgv = process.argv;
    const originalCwd = process.cwd();
    let tempDir: string;
    let configPath: string;

    beforeEach(() => {
      // Run from an empty directory so an ambient .env cannot reach the
      // .env-before-TOML load that --config now triggers.
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toml-dsn-conflict-'));
      configPath = path.join(tempDir, 'dbhub.toml');
      process.chdir(tempDir);
      // --config is the only way TOML gets loaded, so it has to be present for
      // the mocked loadTomlConfig() to stand for a state reachable at runtime.
      process.argv = ['node', 'script.js', '--config', configPath];
      vi.mocked(loadTomlConfig).mockReturnValue({
        sources: [{ id: 'db1', type: 'sqlite', dsn: 'sqlite://a.db' }],
        source: 'dbhub.toml',
      } as any);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
      process.argv = originalArgv;
      vi.mocked(loadTomlConfig).mockReturnValue(null);
    });

    it('rejects a --dsn flag supplied alongside TOML config', async () => {
      process.argv = ['node', 'script.js', '--config', configPath, '--dsn=sqlite://:memory:'];
      const { resolveSourceConfigs } = await import('../env.js');

      await expect(resolveSourceConfigs()).rejects.toThrow(
        /The --dsn flag cannot be used with TOML configuration \(dbhub.toml\)/
      );
    });

    it('allows a DSN env var alongside TOML config', async () => {
      // TOML interpolation reads process.env, so `dsn = "${DSN}"` in the config
      // file is a supported way to keep credentials out of it. An exported DSN
      // is config material for TOML, not a competing single-database setup.
      process.env.DSN = 'postgres://user:pass@localhost:5432/mydb';
      const { resolveSourceConfigs } = await import('../env.js');

      await expect(resolveSourceConfigs()).resolves.toMatchObject({
        source: 'dbhub.toml',
      });
    });

    it('loads .env before TOML config so ${VAR} interpolation can resolve', async () => {
      // interpolateEnvVars() reads process.env, so the file has to be loaded
      // before the TOML is parsed for `dsn = "${DSN}"` to resolve.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-before-toml-'));
      const cwd = process.cwd();
      fs.writeFileSync(path.join(dir, '.env'), 'DSN_FROM_ENV_FILE=sqlite://interpolated.db\n');
      process.chdir(dir);
      process.argv = ['node', 'script.js', '--config', path.join(dir, 'dbhub.toml')];
      dotenvState.passthrough = true;

      // Capture what the env var looked like at the moment the TOML was
      // parsed — if .env were loaded after loadTomlConfig(), interpolation
      // would have seen undefined and this test must fail.
      let dsnSeenAtTomlLoadTime: string | undefined;
      vi.mocked(loadTomlConfig).mockImplementation(() => {
        dsnSeenAtTomlLoadTime = process.env.DSN_FROM_ENV_FILE;
        return {
          sources: [{ id: 'db1', type: 'sqlite', dsn: 'sqlite://a.db' }],
          source: 'dbhub.toml',
        } as any;
      });

      try {
        const { resolveSourceConfigs } = await import('../env.js');
        await resolveSourceConfigs();

        expect(dsnSeenAtTomlLoadTime).toBe('sqlite://interpolated.db');
      } finally {
        dotenvState.passthrough = false;
        process.chdir(cwd);
        delete process.env.DSN_FROM_ENV_FILE;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('allows DB_* env vars alongside TOML config', async () => {
      // Same reasoning: these may exist purely to feed ${DB_PASSWORD}-style
      // interpolation in the TOML file.
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_NAME = 'test.db';
      const { resolveSourceConfigs } = await import('../env.js');

      await expect(resolveSourceConfigs()).resolves.toMatchObject({
        source: 'dbhub.toml',
      });
    });
  });
});