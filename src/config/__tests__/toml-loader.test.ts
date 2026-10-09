import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadTomlConfig, buildDSNFromSource, interpolateEnvVars } from '../toml-loader.js';
import type { SourceConfig } from '../../types/config.js';
import { SQLiteConnector } from '../../connectors/sqlite/index.js';
import { MAX_QUERY_TIMEOUT_SECONDS } from '../../utils/query-timeout.js';
import { SQLServerConnector } from '../../connectors/sqlserver/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('TOML Configuration Tests', () => {
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for test config files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-test-'));
    process.chdir(tempDir);
    // Only --config selects a config file, so point it at the file each test
    // writes. Tests covering the absent/explicit-path cases override argv.
    process.argv = ['node', 'test', '--config', path.join(tempDir, 'dbhub.toml')];
  });

  afterEach(() => {
    // Clean up temp directory
    process.chdir(originalCwd);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    process.argv = originalArgv;
    vi.unstubAllEnvs();
  });

  // Write `toml` to the config file selected by --config and load it.
  const loadToml = (toml: string): ReturnType<typeof loadTomlConfig> => {
    fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), toml);
    return loadTomlConfig();
  };

  // A single connection-parameter source of the given type with `extra`
  // appended after the standard fields.
  const sourceToml = (type: string, extra = ''): string =>
    type === 'sqlite'
      ? `
[[sources]]
id = "test_db"
type = "sqlite"
database = "/path/to/database.db"
${extra}
`
      : `
[[sources]]
id = "test_db"
type = "${type}"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
${extra}
`;

  const writeSource = (extra: string, type = 'postgres'): void => {
    fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), sourceToml(type, extra));
  };

  // DSN-based sources used by the per-field validation tables
  const DSN_BY_TYPE: Record<string, string> = {
    postgres: 'postgres://user:pass@localhost:5432/testdb',
    mysql: 'mysql://user:pass@localhost:3306/testdb',
    mariadb: 'mariadb://user:pass@localhost:3306/testdb',
  };

  describe('loadTomlConfig', () => {
    it('should load valid TOML config from dbhub.toml', () => {
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
`);

      expect(result).toBeTruthy();
      expect(result?.sources).toHaveLength(1);
      // DSN should be parsed to populate connection fields
      expect(result?.sources[0]).toEqual({
        id: 'test_db',
        dsn: 'postgres://user:pass@localhost:5432/testdb',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'user',
      });
      expect(result?.source).toBe('dbhub.toml');
    });

    it('should parse DSN and populate connection fields for sqlite', () => {
      const result = loadToml(`
[[sources]]
id = "sqlite_dsn"
dsn = "sqlite:///path/to/database.db"
`);

      expect(result?.sources[0]).toMatchObject({
        id: 'sqlite_dsn',
        type: 'sqlite',
        database: '/path/to/database.db',
      });
      // SQLite should not have host/port/user
      expect(result?.sources[0].host).toBeUndefined();
      expect(result?.sources[0].port).toBeUndefined();
      expect(result?.sources[0].user).toBeUndefined();
    });

    it('should resolve a relative sqlite database against the config file directory', () => {
      // Config lives in a subdirectory while the process runs from tempDir, so
      // resolving against the config file and resolving against process.cwd()
      // produce different answers and the test can tell them apart.
      const confDir = path.join(tempDir, 'conf');
      fs.mkdirSync(path.join(confDir, 'data'), { recursive: true });
      const configPath = path.join(confDir, 'dbhub.toml');
      fs.writeFileSync(
        configPath,
        `
[[sources]]
id = "rel"
type = "sqlite"
database = "data/app.db"
`
      );
      process.argv = ['node', 'test', '--config', configPath];

      const result = loadTomlConfig();

      expect(result?.sources[0].database).toBe(
        path.join(confDir, 'data', 'app.db').replace(/\\/g, '/')
      );
    });

    it('should leave an absolute sqlite database path unchanged', () => {
      const absolute = path.join(tempDir, 'elsewhere', 'app.db').replace(/\\/g, '/');
      const result = loadToml(`
[[sources]]
id = "abs"
type = "sqlite"
database = "${absolute}"
`);

      expect(result?.sources[0].database).toBe(absolute);
    });

    it('should pass the :memory: sentinel through untouched', () => {
      const result = loadToml(`
[[sources]]
id = "mem"
type = "sqlite"
database = ":memory:"
`);

      expect(result?.sources[0].database).toBe(':memory:');
    });

    it.each([
      ['bare flag', ['node', 'test', '--config']],
      ['empty value', ['node', 'test', '--config=']],
    ])('should reject --config with no value (%s)', (_label, argv) => {
      // Without this, parseCommandLineArgs() resolves the flag to the sentinel
      // "true" and the failure surfaces as `not found: true`.
      process.argv = argv;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit: ${code}`);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        expect(() => loadTomlConfig()).toThrow('process.exit: 1');
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('--config requires a value')
        );
      } finally {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('should ignore a dbhub.toml in the current directory', () => {
      // Only --config selects a config file, so running from a directory that
      // happens to contain one must not repoint DBHub at that database.
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), `
[[sources]]
id = "ambient_db"
dsn = "postgres://user:pass@localhost:5432/ambient"
`);
      process.argv = ['node', 'test'];

      expect(loadTomlConfig()).toBeNull();
    });

    it('should load multiple sources', () => {
      const result = loadToml(`
[[sources]]
id = "db1"
dsn = "postgres://user:pass@localhost:5432/db1"

[[sources]]
id = "db2"
dsn = "mysql://user:pass@localhost:3306/db2"

[[sources]]
id = "db3"
type = "sqlite"
database = "/tmp/test.db"
`);

      expect(result?.sources).toHaveLength(3);
      expect(result?.sources[0].id).toBe('db1');
      expect(result?.sources[1].id).toBe('db2');
      expect(result?.sources[2].id).toBe('db3');
    });

    it('should throw error for missing sources array', () => {
      expect(() => loadToml(`
[server]
port = 8080
`)).toThrow('must contain a [[sources]] array');
    });

    it('should throw error for empty sources array', () => {
      expect(() => loadToml(`sources = []`)).toThrow('sources array cannot be empty');
    });

    it('should throw error for duplicate source IDs', () => {
      expect(() => loadToml(`
[[sources]]
id = "duplicate"
dsn = "postgres://user:pass@localhost:5432/db1"

[[sources]]
id = "duplicate"
dsn = "mysql://user:pass@localhost:3306/db2"
`)).toThrow('duplicate source IDs found: duplicate');
    });

    it('should throw error for source without id', () => {
      expect(() => loadToml(`
[[sources]]
dsn = "postgres://user:pass@localhost:5432/db"
`)).toThrow("each source must have an 'id' field");
    });

    it('should throw error for source without DSN or connection params', () => {
      expect(() => loadToml(`
[[sources]]
id = "invalid"
description = "x"
`)).toThrow('must have either');
    });

    it('should throw error for invalid database type', () => {
      expect(() => loadToml(`
[[sources]]
id = "invalid"
type = "db2"
host = "localhost"
`)).toThrow("invalid type 'db2'");
    });

    it('should accept oracle sources and default the port to 1521', () => {
      const config = loadToml(`
[[sources]]
id = "ora"
type = "oracle"
host = "localhost"
database = "FREEPDB1"
user = "app"
password = "secret"
`);
      expect(config!.sources[0].type).toBe('oracle');
      expect(buildDSNFromSource(config!.sources[0])).toBe('oracle://app:secret@localhost:1521/FREEPDB1');
    });

    it('should expand tilde in ssh_agent paths', () => {
      const result = loadToml(`
[[sources]]
id = "remote_db"
dsn = "postgres://user:pass@10.0.0.5:5432/db"
ssh_host = "bastion.example.com"
ssh_user = "ubuntu"
ssh_agent = "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
`);

      expect(result?.sources[0].ssh_agent).toBe(
        path.join(os.homedir(), 'Library', 'Group Containers', '2BUA8C4S2C.com.1password', 't', 'agent.sock')
      );
    });

    it('should not accept the internal ssh_key_discovered marker from TOML', () => {
      const result = loadToml(`
[[sources]]
id = "remote_db"
dsn = "postgres://user:pass@10.0.0.5:5432/db"
ssh_host = "bastion.example.com"
ssh_user = "ubuntu"
ssh_key = "~/.ssh/id_rsa"
ssh_key_discovered = true
`);

      expect(result?.sources[0].ssh_key_discovered).toBeUndefined();
    });

    it('should throw error for non-existent config file specified by --config', () => {
      process.argv = ['node', 'test', '--config', '/nonexistent/path/config.toml'];

      expect(() => loadTomlConfig()).toThrow('Configuration file specified by --config flag not found');
    });

    describe('optional source fields', () => {
      it.each([
        ['connection_timeout = 60', 'postgres', 'connection_timeout', 60],
        ['description = "Production read replica for analytics"', 'postgres', 'description', 'Production read replica for analytics'],
        ['query_timeout = 120', 'postgres', 'query_timeout', 120],
        ['pool_max_connections = 5', 'postgres', 'pool_max_connections', 5],
        ['search_path = "myschema,public"', 'postgres', 'search_path', 'myschema,public'],
        ['timezone = "+09:00"', 'mysql', 'timezone', '+09:00'],
        ['timezone = "Z"', 'mariadb', 'timezone', 'Z'],
        ['charset = "utf8mb4"', 'mysql', 'charset', 'utf8mb4'],
        ['collation = "utf8mb4_0900_ai_ci"', 'mysql', 'collation', 'utf8mb4_0900_ai_ci'],
        ['collation = "utf8mb4_unicode_ci"', 'mariadb', 'collation', 'utf8mb4_unicode_ci'],
      ])('should accept %s for %s and echo it back', (line, type, field, expected) => {
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "${DSN_BY_TYPE[type]}"
${line}
`);

        expect(result).toBeTruthy();
        expect(result?.sources[0][field as keyof SourceConfig]).toBe(expected);
      });

      it('should leave all optional fields undefined when omitted', () => {
        // Covers each optional field in one pass: connection_timeout,
        // description, sslmode, search_path, timezone, charset, collation.
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "mysql://user:pass@localhost:3306/testdb"
`);

        expect(result).toBeTruthy();
        expect(result?.sources[0].connection_timeout).toBeUndefined();
        expect(result?.sources[0].description).toBeUndefined();
        expect(result?.sources[0].sslmode).toBeUndefined();
        expect(result?.sources[0].search_path).toBeUndefined();
        expect(result?.sources[0].timezone).toBeUndefined();
        expect(result?.sources[0].charset).toBeUndefined();
        expect(result?.sources[0].collation).toBeUndefined();
      });

      it.each([-30, 0])('should throw error for non-positive connection_timeout (%i)', (value) => {
        expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
connection_timeout = ${value}
`)).toThrow('invalid connection_timeout');
      });

      it.each([-60, 0])('should throw error for non-positive query_timeout (%i)', (value) => {
        expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
query_timeout = ${value}
`)).toThrow('invalid query_timeout');
      });

      // Node's setTimeout clamps delays above 2^31-1 ms (and non-finite ones)
      // to 1ms, which would turn the client-side fallback into an immediate
      // timeout on every query.
      it.each([
        ['infinite', 'inf'],
        ['NaN', 'nan'],
        ['beyond the timer range', String(MAX_QUERY_TIMEOUT_SECONDS + 1)],
      ])('should reject a query_timeout that is %s', (_label, value) => {
        expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
query_timeout = ${value}
`)).toThrow('invalid query_timeout');
      });

      it('should accept a query_timeout at the timer-range limit', () => {
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
query_timeout = ${MAX_QUERY_TIMEOUT_SECONDS}
`);
        expect(result?.sources[0].query_timeout).toBe(MAX_QUERY_TIMEOUT_SECONDS);
      });

      it.each([
        ['zero', '0'],
        ['negative', '-1'],
        ['fractional', '1.5'],
        ['string', '"5"'],
        ['above the limit', '1001'],
      ])('should reject a %s pool_max_connections value', (_label, value) => {
        expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
pool_max_connections = ${value}
`)).toThrow('invalid pool_max_connections');
      });
    });

    describe('type-restricted fields', () => {
      // Each row trips the `source.type !== ...` guard for one field. The type
      // is populated from the DSN before validation, so DSN-only sources hit
      // the same guard and need no separate rows.
      it.each([
        ['sslmode', 'sqlite', 'sslmode = "require"', 'SQLite does not support SSL'],
        ['sslrootcert', 'oracle', 'sslmode = "verify-full"\nsslrootcert = "/etc/ssl/ca.pem"', 'sslrootcert but it is only supported for PostgreSQL'],
        ['sslcert/sslkey', 'mysql', 'sslmode = "require"\nsslcert = "/etc/ssl/client.crt"\nsslkey = "/etc/ssl/client.key"', 'sslcert/sslkey but they are only supported for PostgreSQL'],
        ['authentication', 'postgres', 'authentication = "ntlm"', 'authentication but it is only supported for SQL Server'],
        ['domain', 'postgres', 'domain = "MYDOMAIN"', 'domain but it is only supported for SQL Server'],
        ['aws_iam_auth', 'sqlserver', 'aws_iam_auth = true\naws_region = "eu-west-1"', 'only supported for postgres, mysql, and mariadb'],
        ['pool_max_connections', 'mysql', 'pool_max_connections = 5', "'pool_max_connections' but it is only supported for PostgreSQL"],
        ['search_path', 'mysql', 'search_path = "myschema"', "'search_path' but it is only supported for PostgreSQL"],
        ['timezone', 'postgres', 'timezone = "+09:00"', "'timezone' but it is only supported for MySQL and MariaDB"],
        ['charset', 'postgres', 'charset = "utf8mb4"', "'charset' but it is only supported for MySQL and MariaDB"],
        ['collation', 'postgres', 'collation = "utf8mb4_0900_ai_ci"', "'collation' but it is only supported for MySQL and MariaDB"],
      ])('should reject %s for a %s source', (_field, type, extra, message) => {
        writeSource(extra, type);

        expect(() => loadTomlConfig()).toThrow(message);
      });
    });

    describe('invalid field values', () => {
      const ssh = 'ssh_host = "bastion.example.com"\nssh_user = "ubuntu"\n';

      // Empty and non-string values are the two sides of the
      // `typeof !== "string" || trim() === ""` checks, so both stay.
      it.each([
        ['empty ssh_agent', 'postgres', `${ssh}ssh_agent = ""`, 'invalid ssh_agent'],
        ['non-string ssh_agent', 'postgres', `${ssh}ssh_agent = 123`, 'invalid ssh_agent'],
        ['out-of-range ssh_port', 'postgres', `${ssh}ssh_key = "~/.ssh/id_rsa"\nssh_port = 99999`, 'invalid ssh_port'],
        ['non-string aws_profile', 'postgres', 'aws_iam_auth = true\naws_region = "us-east-1"\naws_profile = 42', 'invalid aws_profile'],
        ['blank aws_profile', 'postgres', 'aws_iam_auth = true\naws_region = "us-east-1"\naws_profile = "   "', 'invalid aws_profile'],
        ['IANA-zone timezone', 'mysql', 'timezone = "Asia/Seoul"', 'invalid timezone'],
        // ["local"] coerces to the string "local" via RegExp.test(), so the
        // typeof guard is required to reject it before it reaches the driver.
        ['non-string timezone (TOML array)', 'mysql', 'timezone = ["local"]', 'invalid timezone'],
        ['empty charset', 'mysql', 'charset = ""', 'invalid charset'],
        ['non-string charset (TOML array)', 'mysql', 'charset = ["utf8mb4"]', 'invalid charset'],
        ['empty collation', 'mysql', 'collation = ""', 'invalid collation'],
        ['non-string collation (TOML array)', 'mysql', 'collation = ["utf8mb4_0900_ai_ci"]', 'invalid collation'],
      ])('should reject %s', (_label, type, extra, message) => {
        expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "${DSN_BY_TYPE[type]}"
${extra}
`)).toThrow(message);
      });
    });

    describe('DSN/field conflicts', () => {
      // A DSN already encodes the connection identity; setting a field to a
      // different value is silently ignored at connection time, so it must error.
      it.each([
        ['host', 'dsn = "postgres://dsn_user:pass@dsn_host:5432/dsn_db"\ntype = "postgres"\nhost = "explicit_host"', 'conflicting host'],
        ['user', 'dsn = "postgres://dsn_user:pass@localhost:5432/db"\nuser = "other_user"', 'conflicting user'],
        ['database', 'dsn = "postgres://user:pass@localhost:5432/dsn_db"\ndatabase = "other_db"', 'conflicting database'],
        ['sslmode', 'dsn = "postgres://user:pass@localhost:5432/db?sslmode=disable"\nsslmode = "require"', 'conflicting sslmode'],
        // SafeURL drops `?sslmode=`, but an empty DSN value is still "present"
        ['sslmode against an empty DSN sslmode (?sslmode=)', 'dsn = "postgres://user:pass@localhost:5432/db?sslmode="\nsslmode = "require"', 'conflicting sslmode'],
        ['type = "sqlite" against a non-SQLite DSN', 'type = "sqlite"\ndsn = "postgres://user:pass@localhost:5432/db"', 'conflicting type'],
        ['type = "postgres" against a SQLite DSN', 'type = "postgres"\ndsn = "sqlite:///path/to/db.sqlite"', 'conflicting type'],
        ['instanceName', 'dsn = "sqlserver://sa:pass@localhost:1433/db?instanceName=ENV1"\ninstanceName = "ENV2"', 'conflicting instanceName'],
        ['sslcert', 'dsn = "postgres://user:pass@localhost:5432/db?sslmode=require&sslcert=%2Fother.crt&sslkey=%2Fclient.key"\nsslcert = "/client.crt"\nsslkey = "/client.key"', 'conflicting sslcert'],
      ])('should reject a %s field that conflicts with the DSN', (_label, body, message) => {
        expect(() => loadToml(`
[[sources]]
id = "test_db"
${body}
`)).toThrow(message);
      });

      it('should accept a host field that differs only in case from the DSN', () => {
        const result = loadToml(`
[[sources]]
id = "case_host"
dsn = "postgres://user:pass@DB.EXAMPLE.COM:5432/db"
host = "db.example.com"
`);

        expect(result?.sources[0].id).toBe('case_host');
      });

      it('should accept identity fields that match the DSN', () => {
        const result = loadToml(`
[[sources]]
id = "redundant"
dsn = "postgres://dsn_user:pass@dsn_host:5432/dsn_db"
type = "postgres"
host = "dsn_host"
port = 5432
database = "dsn_db"
user = "dsn_user"
`);

        expect(result?.sources[0]).toMatchObject({
          id: 'redundant',
          type: 'postgres',
          host: 'dsn_host',
          port: 5432,
          database: 'dsn_db',
          user: 'dsn_user',
        });
      });

      it('should throw error when a database field is paired with a DSN naming no database', () => {
        // The field is never injected into the DSN, so accepting this would
        // silently connect without a default database
        expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "mysql://user:pass@localhost:3306/"
database = "myapp"
`)).toThrow("the DSN names no database");
      });

      it('should throw error when password field conflicts with DSN password', () => {
        const toml = `
[[sources]]
id = "test_db"
dsn = "postgres://user:dsn_pass@localhost:5432/db"
password = "other_pass"
`;

        expect(() => loadToml(toml)).toThrow("password' field that conflicts");
        // The error must not echo either password value
        expect(() => loadToml(toml)).not.toThrow(/dsn_pass|other_pass/);
      });

      it('should report a clear error when password field is set but DSN has no password', () => {
        const toml = `
[[sources]]
id = "test_db"
dsn = "postgres://user@localhost:5432/db"
password = "field_pass"
`;

        expect(() => loadToml(toml)).toThrow("the DSN has no password");
        expect(() => loadToml(toml)).not.toThrow(/field_pass/);
      });
    });

    describe('sslmode validation', () => {
      it('should preserve a matching encoded SQL Server sslmode', async () => {
        const dsn = 'sqlserver://user:pass@localhost:1433/db?%73slmode=verify%2Dfull';
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "${dsn}"
sslmode = "verify-full"
`);
        const builtDSN = buildDSNFromSource(result!.sources[0]);
        expect(builtDSN).toBe(dsn);
        const config = await new SQLServerConnector().dsnParser.parse(builtDSN);
        expect(config.options?.encrypt).toBe(true);
        expect(config.options?.trustServerCertificate).toBe(false);
      });

      it('should reject a conflicting encoded SQL Server sslmode without reflecting the input', () => {
        expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "sqlserver://user:pass@localhost:1433/db?%73slmode=disable"
sslmode = "verify-full"
`)).toThrow(new Error(
          `Failed to load TOML configuration from ${path.join(tempDir, 'dbhub.toml')}: ` +
          'Conflicting SQL Server sslmode. Set sslmode in only one place, or make the two values match.'
        ));
      });

      it.each(['disable', 'verify-full', ''])(
        'should reject duplicate SQL Server modes after TOML processing (%j)',
        async (trailingMode) => {
          const dsn = `sqlserver://user:pass@localhost:1433/db?sslmode=verify-full&sslmode=${trailingMode}`;
          const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "${dsn}"
sslmode = "verify-full"
`);
          const builtDSN = buildDSNFromSource(result!.sources[0]);
          expect(result?.sources[0].sslmode).toBe('verify-full');
          expect(builtDSN).toBe(dsn);
          await expect(new SQLServerConnector().dsnParser.parse(builtDSN)).rejects.toMatchObject({
            message: 'Failed to parse SQL Server DSN: Invalid sslmode. Specify exactly one value: disable, require, verify-full',
          });
        }
      );

      it.each([
        ['disable', 'postgres', 'postgres://user:pass@localhost:5432/testdb?sslmode=disable'],
        ['require', 'postgres', 'postgres://user:pass@localhost:5432/testdb?sslmode=require'],
        ['verify-ca', 'postgres', 'postgres://user:pass@localhost:5432/testdb?sslmode=verify-ca'],
        ['verify-full', 'postgres', 'postgres://user:pass@localhost:5432/testdb?sslmode=verify-full'],
        ['verify-full', 'sqlserver', 'sqlserver://user:pass@localhost:1433/testdb?sslmode=verify-full'],
        ['verify-full', 'oracle', 'oracle://user:pass@localhost:1521/testdb?sslmode=verify-full'],
      ])('should accept sslmode = %j for %s and carry it into the DSN', (sslmode, type, expectedDSN) => {
        writeSource(`sslmode = "${sslmode}"`, type);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].sslmode).toBe(sslmode);
        expect(buildDSNFromSource(result!.sources[0])).toBe(expectedDSN);
      });

      it('should throw error for invalid sslmode value', () => {
        writeSource('sslmode = "invalid"');

        expect(() => loadTomlConfig()).toThrow("invalid sslmode 'invalid'");
      });

      it.each([
        ['literal', '', 'disable'],
        ['environment', '${TEST_SSLMODE}', 'require'],
      ])('should reject an empty %s sslmode before DSN fallback', (_name, sslmode, dsnSslmode) => {
        vi.stubEnv('TEST_SSLMODE', '');

        expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://fakeuser:fakepass@localhost:5432/testdb?sslmode=${dsnSslmode}"
sslmode = "${sslmode}"
`)).toThrow("invalid sslmode ''");
      });

      it('should accept matching DSN sslmode and sslmode field', () => {
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/db?sslmode=require"
sslmode = "require"
`);

        expect(result).toBeTruthy();
        expect(result?.sources[0].sslmode).toBe('require');
      });

      it('should populate sslmode field from DSN query parameter', () => {
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/db?sslmode=require"
`);

        expect(result?.sources[0].sslmode).toBe('require');
      });

      it.each([
        ['verify-ca', 'mysql'],
        ['verify-full', 'mariadb'],
        ['verify-ca', 'sqlserver'],
        ['verify-ca', 'oracle'],
      ])('should reject sslmode = %j for %s', (sslmode, type) => {
        writeSource(`sslmode = "${sslmode}"`, type);

        expect(() => loadTomlConfig()).toThrow(
          `sslmode '${sslmode}' which is not supported for ${type}`
        );
      });

      it.each([
        ['"require"', 'sslmode = "require"'],
        ['not set', ''],
      ])('should reject sslrootcert when sslmode is %s', (_label, sslmodeLine) => {
        const certPath = path.join(tempDir, 'ca.pem');
        fs.writeFileSync(certPath, 'cert-content');
        writeSource(`${sslmodeLine}\nsslrootcert = '${certPath}'`);

        expect(() => loadTomlConfig()).toThrow("sslrootcert requires sslmode 'verify-ca' or 'verify-full'");
      });

      it('should accept sslrootcert with sslmode = "verify-ca" when file exists', () => {
        const certPath = path.join(tempDir, 'ca.pem');
        fs.writeFileSync(certPath, 'cert-content');
        writeSource(`sslmode = "verify-ca"\nsslrootcert = '${certPath}'`);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].sslmode).toBe('verify-ca');
        expect(result?.sources[0].sslrootcert).toBe(certPath);
      });

      it('should reject sslrootcert when file does not exist', () => {
        writeSource('sslmode = "verify-ca"\nsslrootcert = "/nonexistent/ca.pem"');

        expect(() => loadTomlConfig()).toThrow("sslrootcert file not found or not accessible: '/nonexistent/ca.pem'");
      });
    });

    describe('client certificate (sslcert/sslkey) validation', () => {
      let certPath: string;
      let keyPath: string;

      beforeEach(() => {
        certPath = path.join(tempDir, 'client.crt');
        keyPath = path.join(tempDir, 'client.key');
        fs.writeFileSync(certPath, 'cert-content');
        fs.writeFileSync(keyPath, 'key-content');
      });

      it.each(['require', 'verify-ca', 'verify-full'])(
        'should accept sslcert + sslkey with sslmode = "%s"',
        (sslmode) => {
          writeSource(`sslmode = "${sslmode}"\nsslcert = '${certPath}'\nsslkey = '${keyPath}'`);

          const result = loadTomlConfig();

          expect(result?.sources[0].sslcert).toBe(certPath);
          expect(result?.sources[0].sslkey).toBe(keyPath);
          expect(buildDSNFromSource(result!.sources[0])).toBe(
            `postgres://user:pass@localhost:5432/testdb?sslmode=${sslmode}` +
              `&sslcert=${encodeURIComponent(certPath)}&sslkey=${encodeURIComponent(keyPath)}`
          );
        }
      );

      it('should accept sslcert + sslkey together with sslrootcert', () => {
        const caPath = path.join(tempDir, 'ca.pem');
        fs.writeFileSync(caPath, 'ca-content');
        writeSource(
          `sslmode = "verify-full"\nsslrootcert = '${caPath}'\nsslcert = '${certPath}'\nsslkey = '${keyPath}'`
        );

        const result = loadTomlConfig();

        expect(buildDSNFromSource(result!.sources[0])).toBe(
          `postgres://user:pass@localhost:5432/testdb?sslmode=verify-full` +
            `&sslrootcert=${encodeURIComponent(caPath)}` +
            `&sslcert=${encodeURIComponent(certPath)}&sslkey=${encodeURIComponent(keyPath)}`
        );
      });

      // expandHomeDir binds os.homedir at import time, so a spy cannot redirect
      // it; write the fixtures under the real home directory instead.
      const withHomeCerts = (fn: (relDir: string, homeCert: string, homeKey: string) => void): void => {
        const relDir = `.dbhub-test-${process.pid}-${Date.now()}`;
        const absDir = path.join(os.homedir(), relDir);
        fs.mkdirSync(absDir, { recursive: true });
        try {
          fs.writeFileSync(path.join(absDir, 'client.crt'), 'cert');
          fs.writeFileSync(path.join(absDir, 'client.key'), 'key');
          fn(relDir, path.join(absDir, 'client.crt'), path.join(absDir, 'client.key'));
        } finally {
          fs.rmSync(absDir, { recursive: true, force: true });
        }
      };

      it('should expand ~ in sslcert and sslkey', () => {
        withHomeCerts((relDir, homeCert, homeKey) => {
          writeSource(`sslmode = "require"\nsslcert = "~/${relDir}/client.crt"\nsslkey = "~/${relDir}/client.key"`);

          const result = loadTomlConfig();

          expect(result?.sources[0].sslcert).toBe(homeCert);
          expect(result?.sources[0].sslkey).toBe(homeKey);
        });
      });

      it.each([
        ['sslcert', 'sslkey'],
        ['sslkey', 'sslcert'],
      ])('should reject %s without %s', (present, missing) => {
        const file = present === 'sslcert' ? certPath : keyPath;
        writeSource(`sslmode = "require"\n${present} = '${file}'`);

        expect(() => loadTomlConfig()).toThrow(`has ${present} without ${missing}`);
      });

      it.each([
        ['"disable"', 'sslmode = "disable"', "sslmode is 'disable'. sslcert/sslkey require sslmode 'require', 'verify-ca' or 'verify-full'"],
        ['not set', '', "sslmode is 'not set'"],
      ])('should reject sslcert/sslkey when sslmode is %s', (_label, sslmodeLine, message) => {
        writeSource(`${sslmodeLine}\nsslcert = '${certPath}'\nsslkey = '${keyPath}'`);

        expect(() => loadTomlConfig()).toThrow(`sslcert/sslkey but ${message}`);
      });

      it('should reject sslkey when the file does not exist', () => {
        writeSource(`sslmode = "require"\nsslcert = '${certPath}'\nsslkey = "/nonexistent/client.key"`);

        expect(() => loadTomlConfig()).toThrow(
          "sslkey file not found or not accessible: '/nonexistent/client.key'"
        );
      });

      it('should reject sslcert when the path is a directory', () => {
        writeSource(`sslmode = "require"\nsslcert = '${tempDir}'\nsslkey = '${keyPath}'`);

        expect(() => loadTomlConfig()).toThrow(`sslcert path is not a regular file: '${tempDir}'`);
      });

      it('should populate sslcert and sslkey fields from DSN query parameters', () => {
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/db?sslmode=require&sslcert=${encodeURIComponent(certPath)}&sslkey=${encodeURIComponent(keyPath)}"
`);

        expect(result?.sources[0].sslcert).toBe(certPath);
        expect(result?.sources[0].sslkey).toBe(keyPath);
      });

      it('should accept a sslkey field that matches the DSN after ~ expansion', () => {
        withHomeCerts((relDir, homeCert, homeKey) => {
          const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/db?sslmode=require&sslcert=${encodeURIComponent(homeCert)}&sslkey=${encodeURIComponent(homeKey)}"
sslcert = "~/${relDir}/client.crt"
sslkey = "~/${relDir}/client.key"
`);

          expect(result?.sources[0].sslkey).toBe(homeKey);
        });
      });
    });

    describe('SQL Server authentication validation', () => {
      it('should accept authentication = "ntlm" with domain', () => {
        writeSource('authentication = "ntlm"\ndomain = "MYDOMAIN"', 'sqlserver');

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].authentication).toBe('ntlm');
        expect(result?.sources[0].domain).toBe('MYDOMAIN');
      });

      it('should accept authentication = "azure-active-directory-access-token" without password', () => {
        const result = loadToml(`
[[sources]]
id = "test_db"
type = "sqlserver"
host = "myserver.database.windows.net"
database = "testdb"
user = "admin@tenant.onmicrosoft.com"
authentication = "azure-active-directory-access-token"
`);

        expect(result).toBeTruthy();
        expect(result?.sources[0].authentication).toBe('azure-active-directory-access-token');
        expect(result?.sources[0].password).toBeUndefined();
      });

      it.each([
        ['an unknown authentication value', 'authentication = "invalid"', "invalid authentication 'invalid'"],
        ['NTLM authentication without domain', 'authentication = "ntlm"', "'domain' is not specified"],
        ['domain without authentication', 'domain = "MYDOMAIN"', 'authentication is not set'],
        ['domain with non-ntlm authentication', 'authentication = "azure-active-directory-access-token"\ndomain = "MYDOMAIN"', 'Domain is only valid with authentication = "ntlm"'],
      ])('should reject %s', (_label, extra, message) => {
        writeSource(extra, 'sqlserver');

        expect(() => loadTomlConfig()).toThrow(message);
      });

      it('should accept authentication with SQL Server DSN (no explicit type)', () => {
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "sqlserver://user:pass@localhost:1433/testdb"
authentication = "ntlm"
domain = "MYDOMAIN"
`);

        expect(result).toBeTruthy();
        expect(result?.sources[0].authentication).toBe('ntlm');
        expect(result?.sources[0].domain).toBe('MYDOMAIN');
      });
    });

    describe('AWS IAM auth validation', () => {
      it('should reject aws_profile when AWS IAM auth is not enabled', () => {
        writeSource('aws_profile = "development"');

        expect(() => loadTomlConfig()).toThrow(
          'aws_profile requires aws_iam_auth = true'
        );
      });

      it('should accept aws_iam_auth for MySQL without password', () => {
        const result = loadToml(`
[[sources]]
id = "mysql_iam"
type = "mysql"
host = "mydb.abc123.eu-west-1.rds.amazonaws.com"
database = "mydb"
user = "dbuser@example.com"
aws_iam_auth = true
aws_region = "eu-west-1"
aws_profile = "development"
`);

        expect(result).toBeTruthy();
        expect(result?.sources[0]).toMatchObject({
          id: 'mysql_iam',
          type: 'mysql',
          host: 'mydb.abc123.eu-west-1.rds.amazonaws.com',
          database: 'mydb',
          user: 'dbuser@example.com',
          aws_iam_auth: true,
          aws_region: 'eu-west-1',
          aws_profile: 'development',
        });
        expect(result?.sources[0].password).toBeUndefined();
      });

      it('should throw error when aws_iam_auth is enabled without aws_region', () => {
        expect(() => loadToml(`
[[sources]]
id = "mysql_iam_missing_region"
type = "mysql"
host = "mydb.abc123.eu-west-1.rds.amazonaws.com"
database = "mydb"
user = "dbuser@example.com"
aws_iam_auth = true
`)).toThrow('aws_region is not specified');
      });
    });
  });

  describe('buildDSNFromSource', () => {
    it('should return DSN if already provided', () => {
      const source: SourceConfig = {
        id: 'test',
        dsn: 'postgres://user:pass@localhost:5432/db',
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('postgres://user:pass@localhost:5432/db');
    });

    // Each row is one branch of mergeSourceFieldsIntoDSN
    it.each<[string, Omit<SourceConfig, 'id'>, string]>([
      [
        'merge sslmode field into a DSN that lacks it',
        { type: 'postgres', dsn: 'postgres://user:pass@localhost:5432/db', sslmode: 'require' },
        'postgres://user:pass@localhost:5432/db?sslmode=require',
      ],
      [
        'append sslmode with & when DSN already has query params',
        { type: 'sqlserver', dsn: 'sqlserver://user:pass@localhost:1433/db?instanceName=ENV1', sslmode: 'require' },
        'sqlserver://user:pass@localhost:1433/db?instanceName=ENV1&sslmode=require',
      ],
      [
        'not duplicate sslmode when DSN already specifies it',
        { type: 'postgres', dsn: 'postgres://user:pass@localhost:5432/db?sslmode=require', sslmode: 'require' },
        'postgres://user:pass@localhost:5432/db?sslmode=require',
      ],
      [
        'merge instanceName field into a SQL Server DSN that lacks it',
        { type: 'sqlserver', dsn: 'sqlserver://sa:pass@localhost:1433/db', instanceName: 'ENV1' },
        'sqlserver://sa:pass@localhost:1433/db?instanceName=ENV1',
      ],
      [
        'merge authentication and domain fields into a SQL Server DSN',
        { type: 'sqlserver', dsn: 'sqlserver://user:pass@localhost:1433/db', authentication: 'ntlm', domain: 'CORP' },
        'sqlserver://user:pass@localhost:1433/db?authentication=ntlm&domain=CORP',
      ],
      [
        'merge sslrootcert field into a postgres DSN for verify-ca',
        { type: 'postgres', dsn: 'postgres://user:pass@localhost:5432/db', sslmode: 'verify-ca', sslrootcert: '/etc/ssl/ca bundle.pem' },
        'postgres://user:pass@localhost:5432/db?sslmode=verify-ca&sslrootcert=' + encodeURIComponent('/etc/ssl/ca bundle.pem'),
      ],
      [
        'merge sslcert and sslkey fields into a postgres DSN for require',
        { type: 'postgres', dsn: 'postgres://user:pass@localhost:5432/db', sslmode: 'require', sslcert: '/etc/ssl/client cert.crt', sslkey: '/etc/ssl/client.key' },
        'postgres://user:pass@localhost:5432/db?sslmode=require&sslcert=' +
          encodeURIComponent('/etc/ssl/client cert.crt') +
          '&sslkey=' +
          encodeURIComponent('/etc/ssl/client.key'),
      ],
      [
        'not duplicate sslcert/sslkey already present in the DSN',
        { type: 'postgres', dsn: 'postgres://user:pass@localhost:5432/db?sslmode=require&sslcert=%2Fc.crt&sslkey=%2Fc.key', sslcert: '/c.crt', sslkey: '/c.key' },
        'postgres://user:pass@localhost:5432/db?sslmode=require&sslcert=%2Fc.crt&sslkey=%2Fc.key',
      ],
      [
        'not merge sslcert/sslkey when sslmode is disable',
        { type: 'postgres', dsn: 'postgres://user:pass@localhost:5432/db', sslmode: 'disable', sslcert: '/c.crt', sslkey: '/c.key' },
        'postgres://user:pass@localhost:5432/db?sslmode=disable',
      ],
      [
        'not merge sslrootcert when sslmode is not a verify mode',
        { type: 'postgres', dsn: 'postgres://user:pass@localhost:5432/db', sslmode: 'require', sslrootcert: '/etc/ssl/ca.pem' },
        'postgres://user:pass@localhost:5432/db?sslmode=require',
      ],
      // SafeURL drops `?sslmode=`, but the raw presence check must still see it
      // so we never produce an ambiguous `?sslmode=&sslmode=require`.
      [
        'not append a duplicate when the DSN has an empty-valued param',
        { type: 'postgres', dsn: 'postgres://user:pass@localhost:5432/db?sslmode=', sslmode: 'require' },
        'postgres://user:pass@localhost:5432/db?sslmode=',
      ],
      [
        'not produce "?&" when the DSN ends with a bare "?"',
        { type: 'postgres', dsn: 'postgres://user:pass@localhost:5432/db?', sslmode: 'require' },
        'postgres://user:pass@localhost:5432/db?sslmode=require',
      ],
      [
        'not add sslmode to a SQLite DSN',
        { type: 'sqlite', dsn: 'sqlite:///path/to/db.sqlite' },
        'sqlite:///path/to/db.sqlite',
      ],
    ])('should %s', (_label, source, expectedDSN) => {
      expect(buildDSNFromSource({ id: 'test', ...source })).toBe(expectedDSN);
    });

    it.each([
      ['mysql', 3306, 'testdb', 'root', 'secret'],
      ['mariadb', 3306, 'testdb', 'root', 'secret'],
      ['sqlserver', 1433, 'master', 'sa', 'StrongPass123'],
    ])('should build %s DSN with default port %i', (type, port, database, user, password) => {
      const source: SourceConfig = {
        id: 'test',
        type: type as SourceConfig['type'],
        host: 'localhost',
        database,
        user,
        password,
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe(`${type}://${user}:${password}@localhost:${port}/${database}`);
    });

    it('should build PostgreSQL DSN with verify-ca and sslrootcert', () => {
      const source: SourceConfig = {
        id: 'pg_verify',
        type: 'postgres',
        host: 'rds.amazonaws.com',
        port: 5432,
        database: 'testdb',
        user: 'user',
        password: 'pass',
        sslmode: 'verify-ca',
        sslrootcert: '/path/to/ca-bundle.pem'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('postgres://user:pass@rds.amazonaws.com:5432/testdb?sslmode=verify-ca&sslrootcert=%2Fpath%2Fto%2Fca-bundle.pem');
    });

    it('should build SQL Server DSN with Azure AD authentication (no password required)', () => {
      const source: SourceConfig = {
        id: 'sqlserver_azure',
        type: 'sqlserver',
        host: 'myserver.database.windows.net',
        port: 1433,
        database: 'mydb',
        user: 'admin@tenant.onmicrosoft.com',
        // No password - Azure AD access token auth doesn't require it
        authentication: 'azure-active-directory-access-token',
        sslmode: 'require'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('sqlserver://admin%40tenant.onmicrosoft.com:@myserver.database.windows.net:1433/mydb?authentication=azure-active-directory-access-token&sslmode=require');
    });

    it('should build SQL Server DSN with all parameters', () => {
      const source: SourceConfig = {
        id: 'sqlserver_all',
        type: 'sqlserver',
        host: 'sqlserver.corp.local',
        port: 1433,
        database: 'appdb',
        user: 'jsmith',
        password: 'secret',
        instanceName: 'PROD',
        authentication: 'ntlm',
        domain: 'CORP',
        sslmode: 'require'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('sqlserver://jsmith:secret@sqlserver.corp.local:1433/appdb?instanceName=PROD&authentication=ntlm&domain=CORP&sslmode=require');
    });

    it('should build SQLite DSN from database path', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'sqlite',
        database: '/path/to/database.db',
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('sqlite:///path/to/database.db');
    });

    // The DSN is only an intermediate encoding; what matters is the path the
    // connector ends up opening. Asserting the DSN string on its own let an
    // encoding that rewrote absolute paths into relative ones pass unnoticed.
    describe('SQLite path round-trip through SQLiteDSNParser', () => {
      const roundTrip = async (database: string): Promise<string> => {
        const dsn = buildDSNFromSource({ id: 'test', type: 'sqlite', database });
        const { dbPath } = await new SQLiteConnector().dsnParser.parse(dsn);
        return dbPath;
      };

      it('preserves a POSIX absolute path', async () => {
        await expect(roundTrip('/var/lib/app/data.db')).resolves.toBe('/var/lib/app/data.db');
      });

      it('preserves a Windows drive-letter path', async () => {
        await expect(roundTrip('C:/Data/app/data.db')).resolves.toBe('C:/Data/app/data.db');
      });

      it('preserves a path containing spaces', async () => {
        await expect(roundTrip('/var/lib/my app/data.db')).resolves.toBe('/var/lib/my app/data.db');
      });

      it('preserves the :memory: sentinel', async () => {
        await expect(roundTrip(':memory:')).resolves.toBe(':memory:');
      });
    });

    it('should encode special characters in credentials', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'postgres',
        host: 'localhost',
        database: 'db',
        user: 'user@domain.com',
        password: 'pass@word#123',
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('postgres://user%40domain.com:pass%40word%23123@localhost:5432/db');
    });

    it('should throw error when type is missing', () => {
      const source: SourceConfig = {
        id: 'test',
        host: 'localhost',
        database: 'db',
        user: 'user',
        password: 'pass',
      };

      expect(() => buildDSNFromSource(source)).toThrow(
        "'type' field is required when 'dsn' is not provided"
      );
    });

    it('should throw error when SQLite is missing database', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'sqlite',
      };

      expect(() => buildDSNFromSource(source)).toThrow(
        "'database' field is required for SQLite"
      );
    });

    it('should throw error when required connection params are missing', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'postgres',
        host: 'localhost',
        // Missing user, database
      };

      expect(() => buildDSNFromSource(source)).toThrow(
        'missing required connection parameters'
      );
    });

    it('should throw error when password is missing for non-Azure-AD auth', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'postgres',
        host: 'localhost',
        database: 'testdb',
        user: 'user',
        // Missing password
      };

      expect(() => buildDSNFromSource(source)).toThrow(
        'password is required'
      );
    });

    it('should allow missing password when aws_iam_auth is enabled', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'postgres',
        host: 'mydb.abc123.eu-west-1.rds.amazonaws.com',
        database: 'mydb',
        user: 'dbuser@example.com',
        aws_iam_auth: true,
        aws_region: 'eu-west-1',
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('postgres://dbuser%40example.com:@mydb.abc123.eu-west-1.rds.amazonaws.com:5432/mydb');
    });

    it('should still require password for unsupported aws_iam_auth types', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'sqlserver',
        host: 'localhost',
        database: 'master',
        user: 'sa',
        aws_iam_auth: true,
        aws_region: 'eu-west-1',
      };

      expect(() => buildDSNFromSource(source)).toThrow('password is required');
    });

    it('should use custom port when provided', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'postgres',
        host: 'localhost',
        port: 9999,
        database: 'db',
        user: 'user',
        password: 'pass',
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('postgres://user:pass@localhost:9999/db');
    });
  });

  describe('Integration scenarios', () => {
    it('should handle complete multi-database config with SSH tunnels', () => {
      const result = loadToml(`
[[sources]]
id = "prod_pg"
dsn = "postgres://user:pass@10.0.0.5:5432/production"
ssh_host = "bastion.example.com"
ssh_port = 22
ssh_user = "ubuntu"
ssh_key = "~/.ssh/prod_key"

[[sources]]
id = "staging_mysql"
type = "mysql"
host = "localhost"
port = 3307
database = "staging"
user = "devuser"
password = "devpass"

[[sources]]
id = "local_sqlite"
type = "sqlite"
database = "~/databases/local.db"
`);

      expect(result).toBeTruthy();
      expect(result?.sources).toHaveLength(3);

      // Verify first source (with SSH) - DSN fields should be parsed
      expect(result?.sources[0]).toMatchObject({
        id: 'prod_pg',
        dsn: 'postgres://user:pass@10.0.0.5:5432/production',
        type: 'postgres',
        host: '10.0.0.5',
        port: 5432,
        database: 'production',
        user: 'user',
        ssh_host: 'bastion.example.com',
        ssh_port: 22,
        ssh_user: 'ubuntu',
      });
      expect(result?.sources[0].ssh_key).toBe(
        path.join(os.homedir(), '.ssh', 'prod_key')
      );

      // Verify second source (MySQL with params)
      expect(result?.sources[1]).toEqual({
        id: 'staging_mysql',
        type: 'mysql',
        host: 'localhost',
        port: 3307,
        database: 'staging',
        user: 'devuser',
        password: 'devpass',
      });

      // Verify third source (SQLite). Separators are normalised to forward
      // slashes. On Windows path.join yields backslashes, and
      // `sqlite:///C:\Users\...` does not match the drive-letter branch of
      // SQLiteDSNParser, so the expanded path came back out as `/C:\Users\...`
      // and could never be opened.
      expect(result?.sources[2]).toMatchObject({
        id: 'local_sqlite',
        type: 'sqlite',
      });
      expect(result?.sources[2].database).toBe(
        path.join(os.homedir(), 'databases', 'local.db').replace(/\\/g, '/')
      );
    });
  });

  describe('Custom Tool Configuration', () => {
    it('should accept custom tool with readonly and max_rows', () => {
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "get_active_users"
source = "test_db"
description = "Get all active users"
statement = "SELECT * FROM users WHERE active = true"
readonly = true
max_rows = 100
`);

      expect(result).toBeTruthy();
      expect(result?.tools).toBeDefined();
      expect(result?.tools).toHaveLength(1);
      expect(result?.tools![0]).toMatchObject({
        name: 'get_active_users',
        source: 'test_db',
        description: 'Get all active users',
        statement: 'SELECT * FROM users WHERE active = true',
        readonly: true,
        max_rows: 100,
      });
    });

    it('should accept custom tool without readonly or max_rows', () => {
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "update_status"
source = "test_db"
description = "Update user status"
statement = "UPDATE users SET status = $1 WHERE id = $2"

[[tools.parameters]]
name = "status"
type = "string"
description = "New status"
required = true

[[tools.parameters]]
name = "user_id"
type = "integer"
description = "User ID"
required = true
`);

      expect(result?.tools).toHaveLength(1);
      expect(result?.tools![0]).toMatchObject({
        name: 'update_status',
        description: 'Update user status',
      });
      expect(result?.tools![0].readonly).toBeUndefined();
      expect(result?.tools![0].max_rows).toBeUndefined();
    });

    it('should throw error for custom tool with invalid readonly type', () => {
      expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "test_tool"
source = "test_db"
description = "Test tool"
statement = "SELECT 1"
readonly = "yes"
`)).toThrow('invalid readonly');
    });

    // The max_rows check runs after the builtin/custom fork, so both kinds of
    // tool share it.
    it.each([
      ['custom tool', -50, 'name = "test_tool"\ndescription = "Test tool"\nstatement = "SELECT 1"'],
      ['custom tool', 0, 'name = "test_tool"\ndescription = "Test tool"\nstatement = "SELECT 1"'],
      ['execute_sql', -100, 'name = "execute_sql"'],
    ])('should throw error for %s with non-positive max_rows (%i)', (_label, value, toolFields) => {
      expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
${toolFields}
source = "test_db"
max_rows = ${value}
`)).toThrow('invalid max_rows');
    });
  });

  // Both are built-in tools other than execute_sql, so they share one
  // validation path.
  describe.each(['explain_sql', 'health_check'])('%s tool configuration', (toolName) => {
    const toolToml = (extra = ''): string => `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "${toolName}"
source = "test_db"
${extra}
`;

    it(`should accept ${toolName} with just name and source`, () => {
      const result = loadToml(toolToml());

      expect(result?.tools).toHaveLength(1);
      expect(result?.tools![0]).toMatchObject({
        name: toolName,
        source: 'test_db',
      });
    });

    it(`should reject ${toolName} with description/statement/parameters`, () => {
      expect(() => loadToml(toolToml('description = "not allowed"\nstatement = "SELECT 1"'))).toThrow(
        `built-in tool '${toolName}' cannot have description, statement, or parameters fields`
      );
    });

    it(`should reject ${toolName} with readonly or max_rows`, () => {
      expect(() => loadToml(toolToml('readonly = true'))).toThrow(
        `tool '${toolName}' cannot have readonly or max_rows fields`
      );
    });

    it(`should pass a custom tool named ${toolName}_foo through as a non-builtin`, () => {
      // toml-loader itself doesn't reject the naming collision (that's
      // enforced by ToolRegistry.validateCustomTool), but it must at least
      // parse the tool through unchanged as a non-builtin so the registry can
      // catch it.
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "${toolName}_foo"
source = "test_db"
description = "Custom tool colliding with ${toolName} naming"
statement = "SELECT 1"
`);
      expect(result?.tools).toHaveLength(1);
      expect(result?.tools![0].name).toBe(`${toolName}_foo`);
    });
  });

  describe('environment variable interpolation', () => {
    // interpolateEnvVars recurses over every string in the parsed TOML, so the
    // DSN cases below cover connection, SSH and tool fields as well.
    it('should interpolate ${VAR} in DSN strings', () => {
      vi.stubEnv('TEST_DB_PASSWORD', 's3cret');
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:\${TEST_DB_PASSWORD}@localhost:5432/testdb"
`);

      expect(result?.sources[0].dsn).toBe('postgres://user:s3cret@localhost:5432/testdb');
    });

    it('should interpolate multiple variables in a single string', () => {
      vi.stubEnv('TEST_DB_USER', 'admin');
      vi.stubEnv('TEST_DB_PASSWORD', 'p@ss');
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://\${TEST_DB_USER}:\${TEST_DB_PASSWORD}@localhost:5432/testdb"
`);

      expect(result?.sources[0].dsn).toBe('postgres://admin:p@ss@localhost:5432/testdb');
    });

    it('should leave unresolved variables as-is', () => {
      delete process.env.NONEXISTENT_VAR;
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:\${NONEXISTENT_VAR}@localhost:5432/testdb"
`);

      expect(result?.sources[0].dsn).toBe('postgres://user:${NONEXISTENT_VAR}@localhost:5432/testdb');
    });

    it('should not affect non-string values', () => {
      const result = interpolateEnvVars({ port: 5432, enabled: true, items: [1, 2] });
      expect(result).toEqual({ port: 5432, enabled: true, items: [1, 2] });
    });

    it('should preserve Date objects from TOML datetime fields', () => {
      const date = new Date('2024-01-01T00:00:00Z');
      const result = interpolateEnvVars({ name: 'test', created: date });
      expect((result as any).created).toBeInstanceOf(Date);
      expect((result as any).created.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });
  });
});
