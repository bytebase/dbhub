import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildDSNFromEnvParams,
  redactDSN,
  resolveDSN,
  resolveHost,
  resolveId,
  resolveSourceConfigs,
} from '../env.js';
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
  // Store original env/argv values to restore after tests
  const originalEnv = { ...process.env };
  const originalArgv = process.argv;

  // Baseline for the non-SQLite env-var path; individual tests override one key.
  const baseEnv = {
    DB_TYPE: 'postgres',
    DB_HOST: 'localhost',
    DB_USER: 'user',
    DB_PASSWORD: 'pass',
    DB_NAME: 'db',
  };

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
    process.argv = ['node', 'script.js'];
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
    process.argv = originalArgv;
  });

  describe('buildDSNFromEnvParams', () => {
    it.each([
      ['postgres', 'postgres', 5432],
      ['postgresql', 'postgres', 5432],
      ['POSTGRES', 'postgres', 5432],
      ['mysql', 'mysql', 3306],
      ['mariadb', 'mariadb', 3306],
      ['sqlserver', 'sqlserver', 1433],
      ['oracle', 'oracle', 1521],
    ])(
      'should build DB_TYPE=%s as a %s:// DSN with default port %i when DB_PORT is not set',
      (type, protocol, port) => {
        Object.assign(process.env, baseEnv, { DB_TYPE: type, DB_HOST: 'db.example.com', DB_NAME: 'mydb' });

        const result = buildDSNFromEnvParams();

        expect(result).toEqual({
          dsn: `${protocol}://user:pass@db.example.com:${port}/mydb`,
          source: 'individual environment variables'
        });
      }
    );

    it('should use custom port when provided', () => {
      Object.assign(process.env, baseEnv, { DB_PORT: '9999' });

      const result = buildDSNFromEnvParams();

      expect(result?.dsn).toBe('postgres://user:pass@localhost:9999/db');
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

    it('should handle SQLite with special characters in file path', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_NAME = '/tmp/test_db@#$.db';

      const result = buildDSNFromEnvParams();

      expect(result).toEqual({
        dsn: 'sqlite:////tmp/test_db@#$.db',
        source: 'individual environment variables'
      });
    });

    it.each([
      ['DB_PASSWORD', 'test@pass:with/special#chars&more=special',
        'postgres://user:test%40pass%3Awith%2Fspecial%23chars%26more%3Dspecial@localhost:5432/db'],
      ['DB_USER', 'user@domain.com', 'postgres://user%40domain.com:pass@localhost:5432/db'],
      ['DB_NAME', 'my-db@test', 'postgres://user:pass@localhost:5432/my-db%40test'],
      // Cyrillic characters
      ['DB_NAME', 'тест_база_данных',
        'postgres://user:pass@localhost:5432/%D1%82%D0%B5%D1%81%D1%82_%D0%B1%D0%B0%D0%B7%D0%B0_%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D1%85'],
    ])('should percent-encode special characters in %s=%s', (key, raw, dsn) => {
      Object.assign(process.env, baseEnv, { [key]: raw });

      const result = buildDSNFromEnvParams();

      expect(result?.dsn).toBe(dsn);
    });

    it.each([
      ['DB_USER, DB_PASSWORD and DB_NAME are missing for a non-SQLite database',
        { DB_TYPE: 'postgres', DB_HOST: 'localhost' }],
      ['DB_TYPE is missing', { DB_HOST: 'localhost', DB_USER: 'user', DB_PASSWORD: 'pass', DB_NAME: 'db' }],
      ['DB_PASSWORD is empty (required field)', { ...baseEnv, DB_PASSWORD: '' }],
      ['SQLite is missing DB_NAME', { DB_TYPE: 'sqlite' }],
    ])('should return null when %s', (_label, env) => {
      Object.assign(process.env, env);

      const result = buildDSNFromEnvParams();

      expect(result).toBeNull();
    });

    it('should throw error for unsupported database type', () => {
      Object.assign(process.env, baseEnv, { DB_TYPE: 'db2' });

      expect(() => buildDSNFromEnvParams()).toThrow(
        'Unsupported DB_TYPE: db2. Supported types: postgres, postgresql, mysql, mariadb, sqlserver, sqlite, oracle'
      );
    });
  });

  describe('resolveDSN integration with individual parameters', () => {
    it('should use DSN when both DSN and individual parameters are provided', () => {
      process.env.DSN = 'postgres://direct:dsn@localhost:5432/directdb';
      Object.assign(process.env, baseEnv, { DB_TYPE: 'mysql' });

      const result = resolveDSN();

      expect(result).toEqual({
        dsn: 'postgres://direct:dsn@localhost:5432/directdb',
        source: 'environment variable'
      });
    });

    it('should fall back to individual parameters when DSN is not provided', () => {
      Object.assign(process.env, baseEnv);

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
  });

  describe('resolveSourceConfigs with special character passwords', () => {
    it('should parse DSN with special characters via SafeURL', async () => {
      // Test that command line DSN with special characters in password is parsed correctly
      // This verifies that SafeURL is used instead of native URL() constructor
      process.argv = ['node', 'script.js', '--dsn=postgres://user:my@pass:word@localhost:5432/testdb'];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources).toHaveLength(1);
      expect(result!.sources[0].type).toBe('postgres');
      expect(result!.sources[0].dsn).toBe('postgres://user:my@pass:word@localhost:5432/testdb');
    });

    it('should not leak the password when the DSN is malformed', async () => {
      // A scheme-less DSN fails SafeURL parsing; the resulting fatal error is
      // printed to stderr, so the raw value must never be interpolated into it.
      process.argv = ['node', 'script.js', '--dsn=user:hunter2@localhost/db'];

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
    // redactDSN delegates to obfuscateDSNPassword; its edge cases are covered
    // in src/utils/__tests__/dsn-obfuscate.test.ts.
    it('should replace the password with asterisks', () => {
      const result = redactDSN('postgres://user:hunter2@localhost:5432/db');
      expect(result).not.toContain('hunter2');
      expect(result).toMatch(/^postgres:\/\/user:\*+@localhost:5432\/db$/);
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
    const DEFAULT = { host: '0.0.0.0', source: 'default' };
    const fromEnv = (host: string) => ({ host, source: 'environment variable' });
    const fromCli = (host: string) => ({ host, source: 'command line argument' });

    beforeEach(() => {
      delete process.env.HOST;
      delete process.env.DBHUB_HOST;
    });

    it.each([
      ['defaults to 0.0.0.0 when nothing is set', {}, [], DEFAULT],
      ['reads DBHUB_HOST from the environment variable', { DBHUB_HOST: '127.0.0.1' }, [], fromEnv('127.0.0.1')],
      ['ignores the generic HOST env var to avoid shell/CI collisions', { HOST: 'my-laptop.local' }, [], DEFAULT],
      // Without trimming, Node's listen() would be handed "   " verbatim and
      // fail with an obscure bind error. Consistent with the `--host` flag
      // validation, treat blank-after-trim (empty or whitespace-only) as
      // "not set" rather than silently misconfigured.
      ['treats a blank (empty or whitespace-only) DBHUB_HOST as unset and falls back to default',
        { DBHUB_HOST: '   ' }, [], DEFAULT],
      ['trims surrounding whitespace from DBHUB_HOST env var', { DBHUB_HOST: '  127.0.0.1  ' }, [], fromEnv('127.0.0.1')],
      ['reads --host from command line arguments (equals form)', {}, ['--host=10.0.0.5'], fromCli('10.0.0.5')],
      ['reads --host from command line arguments (space form)', {}, ['--host', '192.168.1.10'], fromCli('192.168.1.10')],
      ['prefers --host over DBHUB_HOST environment variable',
        { DBHUB_HOST: '0.0.0.0' }, ['--host=127.0.0.1'], fromCli('127.0.0.1')],
      ['trims surrounding whitespace from --host CLI value', {}, ['--host=  127.0.0.1  '], fromCli('127.0.0.1')],
      // Intentionally not validated here: node's listen() rejects it later.
      ['passes through an explicit --host=true without erroring', {}, ['--host=true'], fromCli('true')],
    ])('%s', (_label, env, argv, expected) => {
      Object.assign(process.env, env);
      process.argv = ['node', 'script.js', ...argv];

      const result = resolveHost();

      expect(result).toEqual(expected);
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
  });

  describe('resolveSourceConfigs TOML/DSN conflict', () => {
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
      vi.mocked(loadTomlConfig).mockReturnValue(null);
    });

    it('rejects a --dsn flag supplied alongside TOML config', async () => {
      process.argv = ['node', 'script.js', '--config', configPath, '--dsn=sqlite://:memory:'];

      await expect(resolveSourceConfigs()).rejects.toThrow(
        /The --dsn flag cannot be used with TOML configuration \(dbhub.toml\)/
      );
    });

    it('allows a DSN env var alongside TOML config', async () => {
      // TOML interpolation reads process.env, so `dsn = "${DSN}"` in the config
      // file is a supported way to keep credentials out of it. An exported DSN
      // (or DB_* vars) is config material for TOML, not a competing
      // single-database setup — only the --dsn flag is checked.
      process.env.DSN = 'postgres://user:pass@localhost:5432/mydb';

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
        await resolveSourceConfigs();

        expect(dsnSeenAtTomlLoadTime).toBe('sqlite://interpolated.db');
      } finally {
        dotenvState.passthrough = false;
        process.chdir(cwd);
        delete process.env.DSN_FROM_ENV_FILE;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
