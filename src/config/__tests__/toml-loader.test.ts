import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadTomlConfig, buildDSNFromSource, interpolateEnvVars, findUnresolvedEnvVars } from '../toml-loader.js';
import type { CustomToolConfig, SourceConfig } from '../../types/config.js';
import { sourceConfigEquals } from '../../utils/config-watcher.js';
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

  const loadSource = (extra: string, type = 'postgres'): ReturnType<typeof loadTomlConfig> =>
    loadToml(sourceToml(type, extra));

  // DSN-based sources used by the per-field validation tables
  const DSN_BY_TYPE: Record<string, string> = {
    postgres: 'postgres://user:pass@localhost:5432/testdb',
    mysql: 'mysql://user:pass@localhost:3306/testdb',
    mariadb: 'mariadb://user:pass@localhost:3306/testdb',
    clickhouse: 'clickhouse://user:pass@localhost:8123/testdb',
  };

  // A single DSN-only source of the given type followed by `extra`.
  const loadDsnSource = (type: string, extra: string): ReturnType<typeof loadTomlConfig> =>
    loadToml(`
[[sources]]
id = "test_db"
dsn = "${DSN_BY_TYPE[type]}"
${extra}
`);

  describe('loadTomlConfig', () => {
    it('should load valid TOML config from dbhub.toml', () => {
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
`);

      expect(result?.sources).toHaveLength(1);
      // DSN should be parsed to populate connection fields. toEqual also pins
      // down that nothing else is set: every optional field (sslmode,
      // connection_timeout, description, ...) stays undefined when omitted.
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

      // Exact match: SQLite gets no host/port/user
      expect(result?.sources[0]).toEqual({
        id: 'sqlite_dsn',
        dsn: 'sqlite:///path/to/database.db',
        type: 'sqlite',
        database: '/path/to/database.db',
      });
    });

    // Load a one-source config that lives in a subdirectory while the process
    // runs from tempDir, so resolving against the config file and resolving
    // against process.cwd() produce different answers and a test can tell them
    // apart.
    const loadFromConfDir = (connection: string): { confDir: string; source: SourceConfig } => {
      const confDir = path.join(tempDir, 'conf');
      fs.mkdirSync(confDir);
      const configPath = path.join(confDir, 'dbhub.toml');
      fs.writeFileSync(configPath, `\n[[sources]]\nid = "rel"\n${connection}\n`);
      process.argv = ['node', 'test', '--config', configPath];
      return { confDir, source: loadTomlConfig()!.sources[0] };
    };

    it('should resolve a relative sqlite database against the config file directory', () => {
      const { confDir, source } = loadFromConfDir('type = "sqlite"\ndatabase = "data/app.db"');

      expect(source.database).toBe(path.join(confDir, 'data', 'app.db').replace(/\\/g, '/'));
    });

    it.each([
      ['sqlite:///./data/app.db'],
      ['sqlite://./data/app.db'],
      ['sqlite://data/app.db'],
    ])('should resolve the relative path in dsn = "%s" against the config file directory', async (dsn) => {
      const { confDir, source } = loadFromConfDir(`dsn = "${dsn}"`);
      const expected = path.join(confDir, 'data', 'app.db');

      expect(source.database).toBe(expected);
      // What matters is the file the connector ends up opening
      const { dbPath } = await new SQLiteConnector().dsnParser.parse(buildDSNFromSource(source));
      expect(dbPath).toBe(expected);
    });

    it('should expand ~ in a sqlite dsn', async () => {
      const source = loadToml(`
[[sources]]
id = "home"
dsn = "sqlite:///~/databases/local.db"
`)!.sources[0];
      const expected = path.join(os.homedir(), 'databases', 'local.db');

      expect(source.database).toBe(expected);
      const { dbPath } = await new SQLiteConnector().dsnParser.parse(buildDSNFromSource(source));
      expect(dbPath).toBe(expected);
    });

    it('should reject a sqlite dsn that names no file', () => {
      expect(() => loadToml(`
[[sources]]
id = "empty"
dsn = "sqlite://"
`)).toThrow(/source 'empty' has an invalid SQLite DSN/);
    });

    describe('tools_read_only marker', () => {
      const writableTool = '[[tools]]\nname = "execute_sql"\nsource = "db"';
      const readOnlyTool = `${writableTool}\nreadonly = true`;
      const load = (connection: string, tools: string): SourceConfig =>
        loadToml(`\n[[sources]]\nid = "db"\n${connection}\n\n${tools}\n`)!.sources[0];

      it('should mark a SQLite source whose tools are all read-only', () => {
        const source = load('dsn = "sqlite:///./shop.db"', `${readOnlyTool}\n\n[[tools]]\nname = "search_objects"\nsource = "db"`);

        expect(source.tools_read_only).toBe(true);
      });

      it.each([
        ['a SQLite source that has no [[tools]] entries', 'dsn = "sqlite:///./shop.db"', ''],
        ['a SQLite source that has a writable execute_sql', 'dsn = "sqlite:///./shop.db"', writableTool],
        ['other databases', 'dsn = "postgres://user:pass@localhost:5432/db"', readOnlyTool],
        ['an in-memory source (DSN)', 'dsn = "sqlite:///:memory:"', readOnlyTool],
        ['an in-memory source (database field)', 'type = "sqlite"\ndatabase = ":memory:"', readOnlyTool],
        // The DSN is what gets opened, whatever `database` says
        ['an in-memory source (DSN beside a database field)', 'dsn = "sqlite:///:memory:"\ndatabase = "shop.db"', readOnlyTool],
        // The marker is internal and never taken from the file
        ['a source that sets tools_read_only in the file', 'dsn = "sqlite:///./shop.db"\ntools_read_only = true', ''],
      ])('should not mark %s', (_label, connection, tools) => {
        expect(load(connection, tools).tools_read_only).toBeUndefined();
      });

      it('should load an in-memory source identically whether or not its tool is read-only', () => {
        const writable = load('dsn = "sqlite:///:memory:"', writableTool);
        const readOnly = load('dsn = "sqlite:///:memory:"', readOnlyTool);

        expect(sourceConfigEquals(writable, readOnly)).toBe(true);
      });
    });

    it('should leave an absolute sqlite database path and the :memory: sentinel unchanged', () => {
      const absolute = path.join(tempDir, 'elsewhere', 'app.db').replace(/\\/g, '/');

      for (const database of [absolute, ':memory:']) {
        const result = loadToml(`
[[sources]]
id = "db"
type = "sqlite"
database = "${database}"
`);

        expect(result?.sources[0].database).toBe(database);
      }
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

    it.each([
      ['a missing sources array', '[server]\nport = 8080', 'must contain a [[sources]] array'],
      ['an empty sources array', 'sources = []', 'sources array cannot be empty'],
      [
        'duplicate source IDs',
        '[[sources]]\nid = "duplicate"\ndsn = "postgres://user:pass@localhost:5432/db1"\n\n' +
          '[[sources]]\nid = "duplicate"\ndsn = "mysql://user:pass@localhost:3306/db2"',
        'duplicate source IDs found: duplicate',
      ],
      ['a source without id', '[[sources]]\ndsn = "postgres://user:pass@localhost:5432/db"', "each source must have an 'id' field"],
      ['a source without DSN or connection params', '[[sources]]\nid = "invalid"\ndescription = "x"', 'must have either'],
      ['an invalid database type', '[[sources]]\nid = "invalid"\ntype = "db2"\nhost = "localhost"', "invalid type 'db2'"],
    ])('should throw error for %s', (_label, toml, message) => {
      expect(() => loadToml(toml)).toThrow(message);
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

    it('should expand tilde in ssh_agent paths and not take the internal ssh_key_discovered marker from TOML', () => {
      const result = loadToml(`
[[sources]]
id = "remote_db"
dsn = "postgres://user:pass@10.0.0.5:5432/db"
ssh_host = "bastion.example.com"
ssh_user = "ubuntu"
ssh_key = "~/.ssh/id_rsa"
ssh_key_discovered = true
ssh_agent = "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
`);

      expect(result?.sources[0].ssh_agent).toBe(
        path.join(os.homedir(), 'Library', 'Group Containers', '2BUA8C4S2C.com.1password', 't', 'agent.sock')
      );
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
        // The largest value the timer range allows (see the rejected rows below)
        [`query_timeout = ${MAX_QUERY_TIMEOUT_SECONDS}`, 'postgres', 'query_timeout', MAX_QUERY_TIMEOUT_SECONDS],
        ['pool_max_connections = 5', 'postgres', 'pool_max_connections', 5],
        ['pool_max_connections = 5', 'mysql', 'pool_max_connections', 5],
        ['search_path = "myschema,public"', 'postgres', 'search_path', 'myschema,public'],
        ['timezone = "+09:00"', 'mysql', 'timezone', '+09:00'],
        ['timezone = "Z"', 'mariadb', 'timezone', 'Z'],
        ['charset = "utf8mb4"', 'mysql', 'charset', 'utf8mb4'],
        ['collation = "utf8mb4_0900_ai_ci"', 'mysql', 'collation', 'utf8mb4_0900_ai_ci'],
        ['collation = "utf8mb4_unicode_ci"', 'mariadb', 'collation', 'utf8mb4_unicode_ci'],
      ])('should accept %s for %s and echo it back', (line, type, field, expected) => {
        const result = loadDsnSource(type, line);

        expect(result?.sources[0][field as keyof SourceConfig]).toBe(expected);
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
        ['applicationIntent', 'mysql', 'applicationIntent = "ReadOnly"', 'applicationIntent but it is only supported for SQL Server'],
        ['aws_iam_auth', 'sqlserver', 'aws_iam_auth = true\naws_region = "eu-west-1"', 'only supported for postgres, mysql, and mariadb'],
        ['pool_max_connections', 'mariadb', 'pool_max_connections = 5', "'pool_max_connections' but it is only supported for PostgreSQL and MySQL"],
        ['search_path', 'mysql', 'search_path = "myschema"', "'search_path' but it is only supported for PostgreSQL"],
        ['timezone', 'postgres', 'timezone = "+09:00"', "'timezone' but it is only supported for MySQL and MariaDB"],
        ['charset', 'postgres', 'charset = "utf8mb4"', "'charset' but it is only supported for MySQL and MariaDB"],
        ['collation', 'postgres', 'collation = "utf8mb4_0900_ai_ci"', "'collation' but it is only supported for MySQL and MariaDB"],
        ['wallet_location', 'postgres', 'sslmode = "require"\nwallet_location = "/opt/wallet"', 'wallet_location but it is only supported for Oracle'],
        ['ssl_server_cert_dn', 'sqlserver', 'sslmode = "require"\nssl_server_cert_dn = "CN=db"', 'ssl_server_cert_dn but it is only supported for Oracle'],
      ])('should reject %s for a %s source', (_field, type, extra, message) => {
        expect(() => loadSource(extra, type)).toThrow(message);
      });
    });

    describe('Oracle wallet options', () => {
      // wallet_location only has to be an existing directory, so the per-test
      // tempDir stands in for a wallet.
      it('should accept a wallet directory and pass the options to the DSN', () => {
        const source = loadSource(
          `sslmode = "require"\nwallet_location = '${tempDir}'\nwallet_password = "w@llet"\nssl_server_cert_dn = "CN=adb.example.com"`,
          'oracle'
        )!.sources[0];
        const dsn = buildDSNFromSource(source);

        expect(dsn).toContain(`wallet_location=${encodeURIComponent(tempDir)}`);
        expect(dsn).toContain('wallet_password=w%40llet');
        expect(dsn).toContain('ssl_server_cert_dn=CN%3Dadb.example.com');
      });

      it.each([
        ['sslmode not set', 'ssl_server_cert_dn = "CN=db"', "sslmode is 'not set'. Oracle wallet/TLS options require sslmode 'require' or 'verify-full'"],
        ['sslmode disable', 'sslmode = "disable"\nssl_server_cert_dn = "CN=db"', "sslmode is 'disable'"],
        ['wallet_password alone', 'sslmode = "require"\nwallet_password = "x"', 'has wallet_password but no wallet_location'],
        ['missing wallet directory', 'sslmode = "require"\nwallet_location = "/nonexistent/dbhub-wallet"', 'wallet_location is not an accessible directory'],
        ['empty value', 'sslmode = "require"\nssl_server_cert_dn = " "', 'has invalid ssl_server_cert_dn'],
      ])('should reject %s', (_case, extra, message) => {
        expect(() => loadSource(extra, 'oracle')).toThrow(message);
      });

      it('should complete wallet_location from the DSN with a wallet_password field', () => {
        const source = loadToml(`
[[sources]]
id = "adb"
dsn = "oracle://app:pass@adb.example.com:1522/svc?sslmode=require&wallet_location=${encodeURIComponent(tempDir)}"
wallet_password = "w@llet"
`)!.sources[0];
        expect(source.wallet_location).toBe(tempDir);
        expect(source.wallet_password).toBe('w@llet');

        const dsn = buildDSNFromSource(source);
        expect(dsn).toContain(`wallet_location=${encodeURIComponent(tempDir)}`);
        expect(dsn).toContain('wallet_password=w%40llet');
        expect(dsn.match(/wallet_location=/g)).toHaveLength(1);
      });

      it.each([
        ['missing wallet directory', 'sslmode=require&wallet_location=%2Fnonexistent%2Fdbhub-wallet', 'wallet_location is not an accessible directory'],
        ['wallet_password alone', 'sslmode=require&wallet_password=x', 'has wallet_password but no wallet_location'],
        ['sslmode disable', 'sslmode=disable&ssl_server_cert_dn=CN%3Ddb', "sslmode is 'disable'"],
        // Present but empty is rejected like an empty field, not ignored
        ['empty value', 'sslmode=require&ssl_server_cert_dn=', 'has invalid ssl_server_cert_dn'],
        ['duplicate parameter', 'sslmode=require&wallet_location=%2Fmissing&wallet_location=%2Ftmp', 'has wallet_location more than once in the DSN'],
      ])('should validate wallet options given only in the DSN (%s)', (_case, query, message) => {
        expect(() => loadToml(`
[[sources]]
id = "adb"
dsn = "oracle://app:pass@adb.example.com:1522/svc?${query}"
`)).toThrow(message);
      });

      it('should reject a wallet_password that conflicts with the DSN without echoing either value', () => {
        let error: Error | undefined;
        try {
          loadToml(`
[[sources]]
id = "adb"
dsn = "oracle://app:pass@adb.example.com:1522/svc?sslmode=require&wallet_location=${encodeURIComponent(tempDir)}&wallet_password=dsnSecret"
wallet_password = "fieldSecret"
`);
        } catch (e) {
          error = e as Error;
        }
        expect(error?.message).toContain('conflicting wallet_password');
        expect(error?.message).not.toContain('dsnSecret');
        expect(error?.message).not.toContain('fieldSecret');
      });
    });

    describe('invalid field values', () => {
      const ssh = 'ssh_host = "bastion.example.com"\nssh_user = "ubuntu"\n';

      // Empty and non-string values are the two sides of the
      // `typeof !== "string" || trim() === ""` checks, so both stay.
      it.each([
        ['negative connection_timeout', 'postgres', 'connection_timeout = -30', 'invalid connection_timeout'],
        ['zero connection_timeout', 'postgres', 'connection_timeout = 0', 'invalid connection_timeout'],
        ['negative query_timeout', 'postgres', 'query_timeout = -60', 'invalid query_timeout'],
        ['zero query_timeout', 'postgres', 'query_timeout = 0', 'invalid query_timeout'],
        // Node's setTimeout clamps delays above 2^31-1 ms (and non-finite ones)
        // to 1ms, which would turn the client-side fallback into an immediate
        // timeout on every query.
        ['infinite query_timeout', 'postgres', 'query_timeout = inf', 'invalid query_timeout'],
        ['NaN query_timeout', 'postgres', 'query_timeout = nan', 'invalid query_timeout'],
        ['query_timeout beyond the timer range', 'postgres', `query_timeout = ${MAX_QUERY_TIMEOUT_SECONDS + 1}`, 'invalid query_timeout'],
        ['zero pool_max_connections', 'postgres', 'pool_max_connections = 0', 'invalid pool_max_connections'],
        ['negative pool_max_connections', 'postgres', 'pool_max_connections = -1', 'invalid pool_max_connections'],
        ['fractional pool_max_connections', 'postgres', 'pool_max_connections = 1.5', 'invalid pool_max_connections'],
        ['string pool_max_connections', 'postgres', 'pool_max_connections = "5"', 'invalid pool_max_connections'],
        ['pool_max_connections above the limit', 'postgres', 'pool_max_connections = 1001', 'invalid pool_max_connections'],
        ['empty ssh_agent', 'postgres', `${ssh}ssh_agent = ""`, 'invalid ssh_agent'],
        ['non-string ssh_agent', 'postgres', `${ssh}ssh_agent = 123`, 'invalid ssh_agent'],
        ['out-of-range ssh_port', 'postgres', `${ssh}ssh_key = "~/.ssh/id_rsa"\nssh_port = 99999`, 'invalid ssh_port'],
        ['non-string aws_profile', 'postgres', 'aws_iam_auth = true\naws_region = "us-east-1"\naws_profile = 42', 'invalid aws_profile'],
        ['blank aws_profile', 'postgres', 'aws_iam_auth = true\naws_region = "us-east-1"\naws_profile = "   "', 'invalid aws_profile'],
        ['aws_profile without aws_iam_auth', 'postgres', 'aws_profile = "development"', 'aws_profile requires aws_iam_auth = true'],
        ['aws_iam_auth without aws_region', 'mysql', 'aws_iam_auth = true', 'aws_region is not specified'],
        ['unknown sslmode', 'postgres', 'sslmode = "invalid"', "invalid sslmode 'invalid'"],
        ['IANA-zone timezone', 'mysql', 'timezone = "Asia/Seoul"', 'invalid timezone'],
        // ["local"] coerces to the string "local" via RegExp.test(), so the
        // typeof guard is required to reject it before it reaches the driver.
        ['non-string timezone (TOML array)', 'mysql', 'timezone = ["local"]', 'invalid timezone'],
        ['empty charset', 'mysql', 'charset = ""', 'invalid charset'],
        ['non-string charset (TOML array)', 'mysql', 'charset = ["utf8mb4"]', 'invalid charset'],
        ['empty collation', 'mysql', 'collation = ""', 'invalid collation'],
        ['non-string collation (TOML array)', 'mysql', 'collation = ["utf8mb4_0900_ai_ci"]', 'invalid collation'],
      ])('should reject %s', (_label, type, extra, message) => {
        expect(() => loadDsnSource(type, extra)).toThrow(message);
      });
    });

    describe('[sources.session]', () => {
      // A row gives the body of the [sources.session] table; `inline` replaces
      // the table with a plain key.
      const sessionToml = (body: string | { inline: string }): string =>
        typeof body === 'string' ? `\n[sources.session]\n${body}` : body.inline;

      it.each([
        ['mysql', 'transaction_read_only = 1\nlock_wait_timeout = 5\ntime_zone = "+09:00"', { transaction_read_only: 1, lock_wait_timeout: 5, time_zone: '+09:00' }],
        ['mysql', 'max_heap_table_size = 9223372036854775807', { max_heap_table_size: 9223372036854775807n }],
        ['postgres', 'lock_timeout = "5s"\n"pg_stat_statements.track" = "all"\njit = false', { lock_timeout: '5s', 'pg_stat_statements.track': 'all', jit: false }],
        ['clickhouse', 'max_rows_to_read = 1000000000\nmax_memory_usage = "10G"\nuse_uncompressed_cache = false', { max_rows_to_read: 1000000000, max_memory_usage: '10G', use_uncompressed_cache: false }],
      ])('should accept a %s session table and echo it back', (type, body, expected) => {
        const result = loadDsnSource(type, sessionToml(body));

        expect(result?.sources[0].session).toEqual(expected);
      });

      it.each([
        ['for a MariaDB source', 'mariadb', 'lock_wait_timeout = 5', 'only supported for MySQL, PostgreSQL and ClickHouse'],
        ['a non-table value', 'mysql', { inline: 'session = 5' }, 'must be a table'],
        ['a datetime in place of the table', 'postgres', { inline: 'session = 2024-01-01T00:00:00Z' }, 'must be a table'],
        ['a local date in place of the table', 'mysql', { inline: 'session = 1979-05-27' }, 'must be a table'],
        ['a name that is not an identifier', 'mysql', '"lock wait" = 5', "invalid setting name 'lock wait'"],
        ['a dotted name on MySQL', 'mysql', '"a.b" = 1', "invalid setting name 'a.b'"],
        ['a name with more than one dot on PostgreSQL', 'postgres', '"a.b.c" = 1', "invalid setting name 'a.b.c'"],
        ['max_execution_time on MySQL', 'mysql', 'MAX_EXECUTION_TIME = 1000', "Use 'query_timeout' instead"],
        ['statement_timeout on PostgreSQL', 'postgres', 'statement_timeout = "5s"', "Use 'query_timeout' instead"],
        ['search_path on PostgreSQL', 'postgres', 'search_path = "app"', "Use 'search_path' instead"],
        ['max_execution_time on ClickHouse', 'clickhouse', 'max_execution_time = 30', "Use 'query_timeout' instead"],
        ['readonly on ClickHouse', 'clickhouse', 'readonly = 2', "Use a tool's 'readonly' option"],
        ['an HTTP interface parameter on ClickHouse', 'clickhouse', 'session_id = "abc"', "a parameter of ClickHouse's HTTP interface"],
        ['a query parameter binding on ClickHouse', 'clickhouse', 'param_tenant = "acme"', "a parameter of ClickHouse's HTTP interface"],
        ['an array value', 'mysql', 'sql_mode = ["ANSI"]', "invalid value for 'sql_mode'"],
        ['a nested table', 'postgres', '[sources.session.lock_timeout]\nx = 1', "invalid value for 'lock_timeout'"],
        ['a date value', 'postgres', 'datestyle = 1979-05-27', "invalid value for 'datestyle'"],
        ['a backslash in a MySQL string', 'mysql', 'sql_mode = "A\\\\B"', 'must not contain backslashes'],
        ['a NUL in a PostgreSQL string', 'postgres', 'application_name = "a\\u0000b"', 'must not contain NUL'],
      ])('should reject %s', (_label, type, body, message) => {
        expect(() => loadDsnSource(type, sessionToml(body))).toThrow(message);
      });
    });

    describe('DSN/field conflicts', () => {
      // A DSN already encodes the connection identity; setting a field to a
      // different value is silently ignored at connection time, so it must error.
      it.each([
        ['host', 'dsn = "postgres://dsn_user:pass@dsn_host:5432/dsn_db"\ntype = "postgres"\nhost = "explicit_host"', 'conflicting host'],
        ['user', 'dsn = "postgres://dsn_user:pass@localhost:5432/db"\nuser = "other_user"', 'conflicting user'],
        ['database', 'dsn = "postgres://user:pass@localhost:5432/dsn_db"\ndatabase = "other_db"', 'conflicting database'],
        // The field is never injected into the DSN, so accepting this would
        // silently connect without a default database
        ['database (the DSN names none)', 'dsn = "mysql://user:pass@localhost:3306/"\ndatabase = "myapp"', 'the DSN names no database'],
        ['sslmode', 'dsn = "postgres://user:pass@localhost:5432/db?sslmode=disable"\nsslmode = "require"', 'conflicting sslmode'],
        // SafeURL drops `?sslmode=`, but an empty DSN value is still "present"
        ['sslmode against an empty DSN sslmode (?sslmode=)', 'dsn = "postgres://user:pass@localhost:5432/db?sslmode="\nsslmode = "require"', 'conflicting sslmode'],
        ['type = "sqlite" against a non-SQLite DSN', 'type = "sqlite"\ndsn = "postgres://user:pass@localhost:5432/db"', 'conflicting type'],
        ['type = "postgres" against a SQLite DSN', 'type = "postgres"\ndsn = "sqlite:///path/to/db.sqlite"', 'conflicting type'],
        ['instanceName', 'dsn = "sqlserver://sa:pass@localhost:1433/db?instanceName=ENV1"\ninstanceName = "ENV2"', 'conflicting instanceName'],
        ['applicationIntent', 'dsn = "sqlserver://sa:pass@localhost:1433/db?applicationIntent=ReadWrite"\napplicationIntent = "ReadOnly"', 'conflicting applicationIntent'],
        // The SQL Server parser decodes query keys, so an encoded key must still count as present
        ['applicationIntent against an ADO.NET-cased DSN key', 'dsn = "sqlserver://sa:pass@localhost:1433/db?ApplicationIntent=ReadWrite"\napplicationIntent = "ReadOnly"', 'conflicting applicationIntent'],
        ['applicationIntent against a percent-encoded DSN key', 'dsn = "sqlserver://sa:pass@localhost:1433/db?%61pplicationIntent=ReadWrite"\napplicationIntent = "ReadOnly"', 'conflicting applicationIntent'],
        ['sslcert', 'dsn = "postgres://user:pass@localhost:5432/db?sslmode=require&sslcert=%2Fother.crt&sslkey=%2Fclient.key"\nsslcert = "/client.crt"\nsslkey = "/client.key"', 'conflicting sslcert'],
      ])('should reject a %s field that conflicts with the DSN', (_label, body, message) => {
        expect(() => loadToml(`
[[sources]]
id = "test_db"
${body}
`)).toThrow(message);
      });

      it('should accept identity fields that match the DSN, comparing the host case-insensitively', () => {
        const result = loadToml(`
[[sources]]
id = "redundant"
dsn = "postgres://dsn_user:pass@DSN_HOST:5432/dsn_db"
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

      it.each([
        ['conflicts with the DSN password', 'postgres://user:dsn_pass@localhost:5432/db', "password' field that conflicts"],
        ['is set but the DSN has no password', 'postgres://user@localhost:5432/db', 'the DSN has no password'],
      ])('should reject a password field that %s without echoing a password', (_label, dsn, message) => {
        const toml = `
[[sources]]
id = "test_db"
dsn = "${dsn}"
password = "field_pass"
`;

        expect(() => loadToml(toml)).toThrow(message);
        // The error must not echo either password value
        expect(() => loadToml(toml)).not.toThrow(/dsn_pass|field_pass/);
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
        ['verify-ca', 'mysql', 'mysql://user:pass@localhost:3306/testdb?sslmode=verify-ca'],
        ['verify-full', 'mysql', 'mysql://user:pass@localhost:3306/testdb?sslmode=verify-full'],
        ['verify-ca', 'mariadb', 'mariadb://user:pass@localhost:3306/testdb?sslmode=verify-ca'],
        ['verify-full', 'mariadb', 'mariadb://user:pass@localhost:3306/testdb?sslmode=verify-full'],
      ])('should accept sslmode = %j for %s and carry it into the DSN', (sslmode, type, expectedDSN) => {
        const result = loadSource(`sslmode = "${sslmode}"`, type);

        expect(result?.sources[0].sslmode).toBe(sslmode);
        expect(buildDSNFromSource(result!.sources[0])).toBe(expectedDSN);
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

      it.each([
        ['populate the sslmode field from the DSN query parameter', ''],
        ['accept an sslmode field that matches the DSN', 'sslmode = "require"'],
      ])('should %s', (_label, sslmodeLine) => {
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/db?sslmode=require"
${sslmodeLine}
`);

        expect(result?.sources[0].sslmode).toBe('require');
      });

      it.each([
        ['verify-ca', 'sqlserver'],
        ['verify-ca', 'oracle'],
      ])('should reject sslmode = %j for %s', (sslmode, type) => {
        expect(() => loadSource(`sslmode = "${sslmode}"`, type)).toThrow(
          `sslmode '${sslmode}' which is not supported for ${type}`
        );
      });

      it.each([
        ['"require"', 'sslmode = "require"'],
        ['not set', ''],
      ])('should reject sslrootcert when sslmode is %s', (_label, sslmodeLine) => {
        const certPath = path.join(tempDir, 'ca.pem');
        fs.writeFileSync(certPath, 'cert-content');

        expect(() => loadSource(`${sslmodeLine}\nsslrootcert = '${certPath}'`)).toThrow(
          "sslrootcert requires sslmode 'verify-ca' or 'verify-full'"
        );
      });

      it('should accept sslrootcert with sslmode = "verify-ca" when file exists', () => {
        const certPath = path.join(tempDir, 'ca.pem');
        fs.writeFileSync(certPath, 'cert-content');
        const result = loadSource(`sslmode = "verify-ca"\nsslrootcert = '${certPath}'`);

        expect(result?.sources[0].sslmode).toBe('verify-ca');
        expect(result?.sources[0].sslrootcert).toBe(certPath);
      });

      it('should reject sslrootcert when file does not exist', () => {
        expect(() => loadSource('sslmode = "verify-ca"\nsslrootcert = "/nonexistent/ca.pem"')).toThrow(
          "sslrootcert file not found or not accessible: '/nonexistent/ca.pem'"
        );
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
          const result = loadSource(`sslmode = "${sslmode}"\nsslcert = '${certPath}'\nsslkey = '${keyPath}'`);

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
        const result = loadSource(
          `sslmode = "verify-full"\nsslrootcert = '${caPath}'\nsslcert = '${certPath}'\nsslkey = '${keyPath}'`
        );

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
          const result = loadSource(`sslmode = "require"\nsslcert = "~/${relDir}/client.crt"\nsslkey = "~/${relDir}/client.key"`);

          expect(result?.sources[0].sslcert).toBe(homeCert);
          expect(result?.sources[0].sslkey).toBe(homeKey);
        });
      });

      it.each([
        ['sslcert', 'sslkey'],
        ['sslkey', 'sslcert'],
      ])('should reject %s without %s', (present, missing) => {
        const file = present === 'sslcert' ? certPath : keyPath;
        expect(() => loadSource(`sslmode = "require"\n${present} = '${file}'`)).toThrow(
          `has ${present} without ${missing}`
        );
      });

      it.each([
        ['"disable"', 'sslmode = "disable"', "sslmode is 'disable'. sslcert/sslkey require sslmode 'require', 'verify-ca' or 'verify-full'"],
        ['not set', '', "sslmode is 'not set'"],
      ])('should reject sslcert/sslkey when sslmode is %s', (_label, sslmodeLine, message) => {
        expect(() => loadSource(`${sslmodeLine}\nsslcert = '${certPath}'\nsslkey = '${keyPath}'`)).toThrow(
          `sslcert/sslkey but ${message}`
        );
      });

      it('should reject sslkey when the file does not exist', () => {
        expect(() => loadSource(`sslmode = "require"\nsslcert = '${certPath}'\nsslkey = "/nonexistent/client.key"`)).toThrow(
          "sslkey file not found or not accessible: '/nonexistent/client.key'"
        );
      });

      it('should reject sslcert when the path is a directory', () => {
        expect(() => loadSource(`sslmode = "require"\nsslcert = '${tempDir}'\nsslkey = '${keyPath}'`)).toThrow(
          `sslcert path is not a regular file: '${tempDir}'`
        );
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
      it.each([
        ['connection parameters', 'type = "sqlserver"\nhost = "localhost"\ndatabase = "testdb"\nuser = "user"\npassword = "pass"'],
        ['a SQL Server DSN (no explicit type)', 'dsn = "sqlserver://user:pass@localhost:1433/testdb"'],
      ])('should accept authentication = "ntlm" with domain alongside %s', (_label, connection) => {
        const result = loadToml(`
[[sources]]
id = "test_db"
${connection}
authentication = "ntlm"
domain = "MYDOMAIN"
`);

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

        expect(result?.sources[0].authentication).toBe('azure-active-directory-access-token');
        expect(result?.sources[0].password).toBeUndefined();
      });

      it.each([
        ['an unknown authentication value', 'authentication = "invalid"', "invalid authentication 'invalid'"],
        ['NTLM authentication without domain', 'authentication = "ntlm"', "'domain' is not specified"],
        ['domain without authentication', 'domain = "MYDOMAIN"', 'authentication is not set'],
        ['domain with non-ntlm authentication', 'authentication = "azure-active-directory-access-token"\ndomain = "MYDOMAIN"', 'Domain is only valid with authentication = "ntlm"'],
        ['an unknown applicationIntent value', 'applicationIntent = "Secondary"', "invalid applicationIntent 'Secondary'"],
        ['a non-string applicationIntent', 'applicationIntent = true', "invalid applicationIntent 'true'"],
      ])('should reject %s', (_label, extra, message) => {
        expect(() => loadSource(extra, 'sqlserver')).toThrow(message);
      });

      it.each(['ReadOnly', 'readwrite'])('should accept applicationIntent = "%s"', (intent) => {
        expect(loadSource(`applicationIntent = "${intent}"`, 'sqlserver')?.sources[0].applicationIntent).toBe(intent);
      });

      it('should accept applicationIntent matching the DSN case-insensitively', () => {
        const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "sqlserver://user:pass@localhost:1433/testdb?applicationIntent=readonly"
applicationIntent = "ReadOnly"
`);

        expect(buildDSNFromSource(result!.sources[0])).toBe('sqlserver://user:pass@localhost:1433/testdb?applicationIntent=readonly');
      });
    });

    describe('AWS IAM auth validation', () => {
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
    });
  });

  describe('buildDSNFromSource', () => {
    it('should return DSN if already provided', () => {
      // No `type`: a raw source carries only what the file gave it
      const source = { id: 'test', dsn: 'postgres://user:pass@localhost:5432/db' } as SourceConfig;

      expect(buildDSNFromSource(source)).toBe('postgres://user:pass@localhost:5432/db');
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
        'merge applicationIntent field into a SQL Server DSN that lacks it',
        { type: 'sqlserver', dsn: 'sqlserver://user:pass@localhost:1433/db?sslmode=require', applicationIntent: 'ReadOnly' },
        'sqlserver://user:pass@localhost:1433/db?sslmode=require&applicationIntent=ReadOnly',
      ],
      [
        'not duplicate applicationIntent when the DSN spells the key ApplicationIntent',
        { type: 'sqlserver', dsn: 'sqlserver://user:pass@localhost:1433/db?ApplicationIntent=ReadOnly', applicationIntent: 'ReadOnly' },
        'sqlserver://user:pass@localhost:1433/db?ApplicationIntent=ReadOnly',
      ],
      [
        'merge Oracle wallet fields into an Oracle DSN',
        { type: 'oracle', dsn: 'oracle://app:pass@adb:1522/svc', sslmode: 'require', wallet_location: '/opt/wallet', wallet_password: 'p&w', ssl_server_cert_dn: 'CN=adb' },
        'oracle://app:pass@adb:1522/svc?sslmode=require&wallet_location=%2Fopt%2Fwallet&wallet_password=p%26w&ssl_server_cert_dn=CN%3Dadb',
      ],
      [
        'not duplicate Oracle wallet params already present in the DSN',
        { type: 'oracle', dsn: 'oracle://app:pass@adb:1522/svc?sslmode=require&wallet_location=%2Fw', sslmode: 'require', wallet_location: '/w' },
        'oracle://app:pass@adb:1522/svc?sslmode=require&wallet_location=%2Fw',
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

    // DSNs built from connection parameters. Default ports per database type
    // are covered by the sslmode table above and the Oracle test.
    it.each<[string, Omit<SourceConfig, 'id'>, string]>([
      [
        // No password - Azure AD access token auth doesn't require it
        'build SQL Server DSN with Azure AD authentication (no password required)',
        { type: 'sqlserver', host: 'myserver.database.windows.net', port: 1433, database: 'mydb', user: 'admin@tenant.onmicrosoft.com', authentication: 'azure-active-directory-access-token', sslmode: 'require' },
        'sqlserver://admin%40tenant.onmicrosoft.com:@myserver.database.windows.net:1433/mydb?authentication=azure-active-directory-access-token&sslmode=require',
      ],
      [
        'build SQL Server DSN with all parameters',
        { type: 'sqlserver', host: 'sqlserver.corp.local', port: 1433, database: 'appdb', user: 'jsmith', password: 'secret', instanceName: 'PROD', authentication: 'ntlm', domain: 'CORP', applicationIntent: 'ReadOnly', sslmode: 'require' },
        'sqlserver://jsmith:secret@sqlserver.corp.local:1433/appdb?instanceName=PROD&authentication=ntlm&domain=CORP&applicationIntent=ReadOnly&sslmode=require',
      ],
      [
        'encode special characters in credentials',
        { type: 'postgres', host: 'localhost', database: 'db', user: 'user@domain.com', password: 'pass@word#123' },
        'postgres://user%40domain.com:pass%40word%23123@localhost:5432/db',
      ],
      [
        'allow missing password when aws_iam_auth is enabled',
        { type: 'postgres', host: 'mydb.abc123.eu-west-1.rds.amazonaws.com', database: 'mydb', user: 'dbuser@example.com', aws_iam_auth: true, aws_region: 'eu-west-1' },
        'postgres://dbuser%40example.com:@mydb.abc123.eu-west-1.rds.amazonaws.com:5432/mydb',
      ],
      [
        'use custom port when provided',
        { type: 'postgres', host: 'localhost', port: 9999, database: 'db', user: 'user', password: 'pass' },
        'postgres://user:pass@localhost:9999/db',
      ],
    ])('should %s', (_label, source, expectedDSN) => {
      expect(buildDSNFromSource({ id: 'test', ...source })).toBe(expectedDSN);
    });

    it.each<[string, Omit<SourceConfig, 'id'>, string]>([
      [
        'type is missing',
        { host: 'localhost', database: 'db', user: 'user', password: 'pass' } as Omit<SourceConfig, 'id'>,
        "'type' field is required when 'dsn' is not provided",
      ],
      ['SQLite is missing database', { type: 'sqlite' }, "'database' field is required for SQLite"],
      [
        'required connection params (user, database) are missing',
        { type: 'postgres', host: 'localhost' },
        'missing required connection parameters',
      ],
      [
        'password is missing for non-Azure-AD auth',
        { type: 'postgres', host: 'localhost', database: 'testdb', user: 'user' },
        'password is required',
      ],
      [
        'required connection params (database) are missing for ClickHouse',
        { type: 'clickhouse', host: 'localhost', user: 'default' },
        'missing required connection parameters',
      ],
      [
        'password is missing and aws_iam_auth is set on an unsupported type',
        { type: 'sqlserver', host: 'localhost', database: 'master', user: 'sa', aws_iam_auth: true, aws_region: 'eu-west-1' },
        'password is required',
      ],
    ])('should throw error when %s', (_label, source, message) => {
      expect(() => buildDSNFromSource({ id: 'test', ...source })).toThrow(message);
    });

    // ClickHouse serves HTTP and HTTPS on different ports, and its out-of-the-box
    // `default` user has no password.
    it.each<[string, Omit<SourceConfig, 'id'>, string]>([
      [
        'the HTTP port without sslmode',
        { type: 'clickhouse', host: 'ch.local', database: 'analytics', user: 'reader', password: 'p@ss' },
        'clickhouse://reader:p%40ss@ch.local:8123/analytics',
      ],
      [
        'the HTTPS port with sslmode=require',
        { type: 'clickhouse', host: 'x.clickhouse.cloud', database: 'default', user: 'default', password: 'pw', sslmode: 'require' },
        'clickhouse://default:pw@x.clickhouse.cloud:8443/default?sslmode=require',
      ],
      [
        'the HTTPS port with sslmode=verify-full',
        { type: 'clickhouse', host: 'x.clickhouse.cloud', database: 'default', user: 'default', password: 'pw', sslmode: 'verify-full' },
        'clickhouse://default:pw@x.clickhouse.cloud:8443/default?sslmode=verify-full',
      ],
      [
        'an explicit port over either default',
        { type: 'clickhouse', host: 'ch.local', port: 9443, database: 'default', user: 'default', password: 'pw', sslmode: 'require' },
        'clickhouse://default:pw@ch.local:9443/default?sslmode=require',
      ],
      [
        'no password',
        { type: 'clickhouse', host: 'localhost', database: 'default', user: 'default' },
        'clickhouse://default:@localhost:8123/default',
      ],
    ])('should build a ClickHouse DSN with %s', (_label, source, expectedDSN) => {
      expect(buildDSNFromSource({ id: 'test', ...source })).toBe(expectedDSN);
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

      it.each([
        ['a POSIX absolute path', '/var/lib/app/data.db'],
        ['a Windows drive-letter path', 'C:/Data/app/data.db'],
        ['a path containing spaces', '/var/lib/my app/data.db'],
        ['the :memory: sentinel', ':memory:'],
      ])('preserves %s', async (_label, database) => {
        await expect(roundTrip(database)).resolves.toBe(database);
      });
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
      expect(result?.sources[0].ssh_key).toBe(path.join(os.homedir(), '.ssh', 'prod_key'));

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
    const customTool = 'name = "test_tool"\ndescription = "Test tool"\nstatement = "SELECT 1"';

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
      const tool = result?.tools![0] as CustomToolConfig;
      expect(tool.readonly).toBeUndefined();
      expect(tool.max_rows).toBeUndefined();
    });

    // The max_rows check runs after the builtin/custom fork, so both kinds of
    // tool share it.
    it.each([
      ['custom tool with a non-boolean readonly', `${customTool}\nreadonly = "yes"`, 'invalid readonly'],
      ['custom tool with a negative max_rows', `${customTool}\nmax_rows = -50`, 'invalid max_rows'],
      ['custom tool with a zero max_rows', `${customTool}\nmax_rows = 0`, 'invalid max_rows'],
      ['execute_sql with a negative max_rows', 'name = "execute_sql"\nmax_rows = -100', 'invalid max_rows'],
    ])('should throw error for %s', (_label, toolFields, message) => {
      expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
source = "test_db"
${toolFields}
`)).toThrow(message);
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

    it('should reject a source that references an unset variable', () => {
      delete process.env.NONEXISTENT_VAR;
      expect(() => loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:\${NONEXISTENT_VAR}@localhost:5432/testdb"
`)).toThrow("source 'test_db' references unset environment variable(s): NONEXISTENT_VAR");
    });

    it('should name every unset variable of a source, not their values', () => {
      delete process.env.MISSING_USER;
      delete process.env.MISSING_PASSWORD;
      vi.stubEnv('TEST_DB_HOST', 'db.internal');
      expect(() => loadToml(`
[[sources]]
id = "test_db"
type = "postgres"
host = "\${TEST_DB_HOST}"
database = "testdb"
user = "\${MISSING_USER}"
password = "\${MISSING_PASSWORD}"
`)).toThrow(/unset environment variable\(s\): MISSING_USER, MISSING_PASSWORD$/);
    });

    it('should identify a source without id by its position', () => {
      delete process.env.NONEXISTENT_VAR;
      expect(() => loadToml(`
[[sources]]
dsn = "postgres://user:\${NONEXISTENT_VAR}@localhost:5432/testdb"
`)).toThrow('source #1 references unset environment variable(s): NONEXISTENT_VAR');
    });

    it('should accept a variable set to an empty string', () => {
      vi.stubEnv('EMPTY_PASSWORD', '');
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:\${EMPTY_PASSWORD}@localhost:5432/testdb"
`);

      expect(result?.sources[0].dsn).toBe('postgres://user:@localhost:5432/testdb');
    });

    it('should not mistake a resolved value containing ${...} for a missing variable', () => {
      vi.stubEnv('TEST_DB_PASSWORD', 'pa${ss}word');
      const result = loadToml(`
[[sources]]
id = "test_db"
dsn = "postgres://user:\${TEST_DB_PASSWORD}@localhost:5432/testdb"
`);

      expect(result?.sources[0].dsn).toBe('postgres://user:pa${ss}word@localhost:5432/testdb');
    });

    it('should report unset variables recursively', () => {
      delete process.env.NONEXISTENT_VAR;
      vi.stubEnv('TEST_SET_VAR', 'x');
      expect(findUnresolvedEnvVars({ a: '${TEST_SET_VAR}', b: ['${NONEXISTENT_VAR}'], c: { d: '${NONEXISTENT_VAR}' }, e: 1 }))
        .toEqual(['NONEXISTENT_VAR']);
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
