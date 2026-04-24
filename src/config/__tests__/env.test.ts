import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildDSNFromEnvParams, resolveDSN, resolveHost, resolveId } from '../env.js';

// Mock toml-loader to prevent it from loading dbhub.toml during tests
vi.mock('../toml-loader.js', () => ({
  loadTomlConfig: vi.fn(() => null),
}));

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

    it('should build MySQL DSN with default port when port not specified', () => {
      process.env.DB_TYPE = 'mysql';
      process.env.DB_HOST = 'mysql.example.com';
      process.env.DB_USER = 'admin';
      process.env.DB_PASSWORD = 'secret';
      process.env.DB_NAME = 'myapp';

      const result = buildDSNFromEnvParams();

      expect(result).toEqual({
        dsn: 'mysql://admin:secret@mysql.example.com:3306/myapp',
        source: 'individual environment variables'
      });
    });

    it('should build MariaDB DSN with default port', () => {
      process.env.DB_TYPE = 'mariadb';
      process.env.DB_HOST = 'mariadb.example.com';
      process.env.DB_USER = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'database';

      const result = buildDSNFromEnvParams();

      expect(result).toEqual({
        dsn: 'mariadb://user:pass@mariadb.example.com:3306/database',
        source: 'individual environment variables'
      });
    });

    it('should build SQL Server DSN with default port', () => {
      process.env.DB_TYPE = 'sqlserver';
      process.env.DB_HOST = 'sqlserver.example.com';
      process.env.DB_USER = 'sa';
      process.env.DB_PASSWORD = 'strongpass';
      process.env.DB_NAME = 'master';

      const result = buildDSNFromEnvParams();

      expect(result).toEqual({
        dsn: 'sqlserver://sa:strongpass@sqlserver.example.com:1433/master',
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
  });

  describe('resolveId', () => {
    it('should return null when ID is not provided', () => {
      const result = resolveId();

      expect(result).toBeNull();
    });

    it('should resolve ID from environment variable', () => {
      process.env.ID = 'prod';

      const result = resolveId();

      expect(result).toEqual({
        id: 'prod',
        source: 'environment variable'
      });
    });

    it('should handle different ID formats', () => {
      process.env.ID = 'staging-db-01';

      const result = resolveId();

      expect(result).toEqual({
        id: 'staging-db-01',
        source: 'environment variable'
      });
    });

    it('should handle numeric IDs as strings', () => {
      process.env.ID = '123';

      const result = resolveId();

      expect(result).toEqual({
        id: '123',
        source: 'environment variable'
      });
    });
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

    it('exits when --host is provided without a value', () => {
      process.argv = ['node', 'script.js', '--host'];
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit: ${code}`);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => resolveHost()).toThrow('process.exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--host requires a value'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('exits when --host is followed by another flag', () => {
      process.argv = ['node', 'script.js', '--host', '--port=8080'];
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit: ${code}`);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => resolveHost()).toThrow('process.exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--host requires a value'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('passes through an explicit --host=true without erroring (node listen will reject it)', () => {
      process.argv = ['node', 'script.js', '--host=true'];

      const result = resolveHost();

      expect(result).toEqual({ host: 'true', source: 'command line argument' });
    });

    it('exits when --host= is provided with an empty value', () => {
      process.argv = ['node', 'script.js', '--host='];
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit: ${code}`);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => resolveHost()).toThrow('process.exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--host requires a value'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('exits when --host= is followed by another flag', () => {
      process.argv = ['node', 'script.js', '--host=', '--port=8080'];
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit: ${code}`);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => resolveHost()).toThrow('process.exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--host requires a value'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('exits when --host= is present even if a non-flag token follows (empty value, no concatenation)', () => {
      // `--host= 127.0.0.1` is not the same as `--host=127.0.0.1`: the token
      // is literally the empty string. parseCommandLineArgs has already been
      // observed to bind the positional that follows to --host, silently
      // accepting what the user almost certainly did not intend.
      process.argv = ['node', 'script.js', '--host=', '127.0.0.1'];
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit: ${code}`);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => resolveHost()).toThrow('process.exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--host requires a value'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('exits when a later bare --host appears after an earlier valid --host', () => {
      // With an early break in the argv scan, only the first --host is
      // inspected — a later duplicate bare --host sneaks through even though
      // it has no value and the user's intent is ambiguous.
      process.argv = ['node', 'script.js', '--host', '127.0.0.1', '--host'];
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit: ${code}`);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => resolveHost()).toThrow('process.exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--host requires a value'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('exits when --host value is whitespace-only (quoted)', () => {
      // Shells can pass a quoted whitespace value through to argv, e.g.
      //   --host="   "
      // The env var path already rejects this; the CLI path should match
      // so the user gets the same friendly error instead of an opaque
      // listen() failure.
      process.argv = ['node', 'script.js', '--host=   '];
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit: ${code}`);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => resolveHost()).toThrow('process.exit: 1');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--host requires a value'));

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('trims surrounding whitespace from --host CLI value', () => {
      process.argv = ['node', 'script.js', '--host=  127.0.0.1  '];

      const result = resolveHost();

      expect(result).toEqual({ host: '127.0.0.1', source: 'command line argument' });
    });
  });
});