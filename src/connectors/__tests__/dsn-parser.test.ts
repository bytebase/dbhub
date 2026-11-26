import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pg from 'pg';
import { PostgresConnector } from '../postgres/index.js';
import { MySQLConnector } from '../mysql/index.js';
import { MariaDBConnector } from '../mariadb/index.js';
import { SQLServerConnector } from '../sqlserver/index.js';
import { OracleConnector } from '../oracle/index.js';
import { ClickHouseConnector } from '../clickhouse/index.js';

/** Write a PEM fixture into a temp dir and return its path. */
function writeTempPem(dir: string, name: string, pem: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, pem);
  return file;
}

describe('DSN Parser - IPv6 hosts', () => {
  it.each([
    [new PostgresConnector(), 'postgres', 5432],
    [new MySQLConnector(), 'mysql', 3306],
    [new MariaDBConnector(), 'mariadb', 3306],
  ] as const)('passes an IPv6 host and port to the %s driver', async (connector, scheme, defaultPort) => {
    const explicit = await connector.dsnParser.parse(`${scheme}://user:pass@[::1]:15432/db`);
    expect(explicit).toMatchObject({ host: '::1', port: 15432, database: 'db' });
    const implicit = await connector.dsnParser.parse(`${scheme}://user:pass@[::1]/db`);
    expect(implicit).toMatchObject({ host: '::1', port: defaultPort, database: 'db' });
  });
});

describe('DSN Parser - PostgreSQL TLS', () => {
  const parser = new PostgresConnector().dsnParser;
  const CA = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n';
  const CERT = '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n';
  const KEY = '-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----\n';
  const ENCRYPTED_KEY =
    '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----\n';
  const base = 'postgres://user:pass@localhost:5432/db';
  let tempDir: string;
  let caPath: string;
  let certPath: string;
  let keyPath: string;

  const rootCertParam = () => `sslrootcert=${encodeURIComponent(caPath)}`;
  const clientCertParams = () =>
    `sslcert=${encodeURIComponent(certPath)}&sslkey=${encodeURIComponent(keyPath)}`;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-pg-tls-test-'));
    caPath = writeTempPem(tempDir, 'ca.pem', CA);
    certPath = writeTempPem(tempDir, 'client.crt', CERT);
    keyPath = writeTempPem(tempDir, 'client.key', KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('SSL modes', () => {
    it.each([
      ['no sslmode', '', undefined],
      ['no sslmode but other parameters', '?application_name=app', undefined],
      ['sslmode=disable', '?sslmode=disable', false],
      ['sslmode=require', '?sslmode=require', { rejectUnauthorized: false }],
      // No checkServerIdentity override, so the hostname is verified as well as the chain
      ['sslmode=verify-full', '?sslmode=verify-full', { rejectUnauthorized: true }],
      ['the last of a repeated sslmode', '?sslmode=disable&sslmode=require', { rejectUnauthorized: false }],
    ])('should map %s to ssl = %j', async (_label, query, ssl) => {
      expect((await parser.parse(`${base}${query}`)).ssl).toStrictEqual(ssl);
    });

    it('should set rejectUnauthorized = true and skip hostname check for sslmode=verify-ca', async () => {
      const config = await parser.parse(`${base}?sslmode=verify-ca`);
      const ssl = config.ssl as Record<string, unknown>;
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(typeof ssl.checkServerIdentity).toBe('function');
      expect((ssl.checkServerIdentity as Function)()).toBeUndefined();
    });

    it('should read CA cert file for sslmode=verify-full with sslrootcert', async () => {
      const config = await parser.parse(`${base}?sslmode=verify-full&${rootCertParam()}`);
      expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: CA });
    });

    it('should throw when sslrootcert points to nonexistent file', async () => {
      const dsn = `${base}?sslmode=verify-ca&sslrootcert=/nonexistent/ca.pem`;
      await expect(parser.parse(dsn)).rejects.toThrow("Failed to read SSL root certificate at '/nonexistent/ca.pem'");
    });

    it.each([
      { sslmode: 'require', got: 'require' },
      { sslmode: 'disable', got: 'disable' },
      { sslmode: undefined, got: 'not set' },
    ])('should reject sslrootcert when sslmode is $got', async ({ sslmode, got }) => {
      const query = sslmode === undefined ? '' : `sslmode=${sslmode}&`;
      await expect(parser.parse(`${base}?${query}${rootCertParam()}`)).rejects.toThrow(
        `sslrootcert requires sslmode 'verify-ca' or 'verify-full' (got '${got}')`
      );
    });

    it.each(['prefer', 'allow', 'verify_full', 'true'])(
      'should reject unsupported sslmode=%s',
      async (sslmode) => {
        await expect(parser.parse(`${base}?sslmode=${sslmode}`)).rejects.toThrow(
          `Unsupported sslmode '${sslmode}'. Valid values: disable, require, verify-ca, verify-full`
        );
      }
    );
  });

  describe('client certificate (sslcert/sslkey)', () => {
    it('should load cert and key with sslmode=require without verifying the server', async () => {
      const config = await parser.parse(`${base}?sslmode=require&${clientCertParams()}`);
      expect(config.ssl).toEqual({ rejectUnauthorized: false, cert: CERT, key: KEY });
    });

    it('should load cert and key with sslmode=verify-ca', async () => {
      const config = await parser.parse(`${base}?sslmode=verify-ca&${clientCertParams()}`);
      const ssl = config.ssl as Record<string, unknown>;
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.cert).toBe(CERT);
      expect(ssl.key).toBe(KEY);
      expect(typeof ssl.checkServerIdentity).toBe('function');
    });

    it('should expand ~ in sslrootcert, sslcert and sslkey paths', async () => {
      vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
      const tilde = (file: string) => encodeURIComponent(`~/${file}`);
      const config = await parser.parse(
        `${base}?sslmode=verify-ca&sslrootcert=${tilde('ca.pem')}&sslcert=${tilde('client.crt')}&sslkey=${tilde('client.key')}`
      );
      expect(config.ssl).toMatchObject({ rejectUnauthorized: true, ca: CA, cert: CERT, key: KEY });
    });

    it.each([
      ['sslcert', 'sslkey'],
      ['sslkey', 'sslcert'],
    ])('should reject %s without %s', async (given, _missing) => {
      const file = given === 'sslcert' ? certPath : keyPath;
      await expect(
        parser.parse(`${base}?sslmode=require&${given}=${encodeURIComponent(file)}`)
      ).rejects.toThrow('sslcert and sslkey must be set together');
    });

    it.each([
      { sslmode: 'disable', got: 'disable' },
      { sslmode: undefined, got: 'not set' },
    ])('should reject a client certificate when sslmode is $got', async ({ sslmode, got }) => {
      const query = sslmode === undefined ? '' : `sslmode=${sslmode}&`;
      await expect(parser.parse(`${base}?${query}${clientCertParams()}`)).rejects.toThrow(
        `sslcert/sslkey require sslmode to be one of require, verify-ca, verify-full (got '${got}')`
      );
    });

    it('should throw FailedToReadCertificate naming the missing key file', async () => {
      fs.rmSync(keyPath);
      const err = await parser
        .parse(`${base}?sslmode=require&${clientCertParams()}`)
        .catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('FailedToReadCertificate');
      expect((err as Error).message).toContain(`Failed to read SSL client key at '${keyPath}'`);
    });

    it('should throw FailedToReadCertificate naming the missing cert file', async () => {
      fs.rmSync(certPath);
      await expect(parser.parse(`${base}?sslmode=require&${clientCertParams()}`)).rejects.toThrow(
        `Failed to read SSL client certificate at '${certPath}'`
      );
    });

    it.each([
      ['PKCS#8', ENCRYPTED_KEY],
      [
        'legacy PEM',
        '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,00\n\nx\n-----END RSA PRIVATE KEY-----\n',
      ],
    ])('should reject an encrypted %s private key with a clear message', async (_format, pem) => {
      fs.writeFileSync(keyPath, pem);
      await expect(parser.parse(`${base}?sslmode=require&${clientCertParams()}`)).rejects.toThrow(
        'encrypted private keys are not supported'
      );
    });
  });

  describe('certificate rotation (sslrootcert/sslcert/sslkey)', () => {
    const NEW_CA = '-----BEGIN CERTIFICATE-----\nca-rotated\n-----END CERTIFICATE-----\n';
    const NEW_CERT = '-----BEGIN CERTIFICATE-----\nclient-rotated\n-----END CERTIFICATE-----\n';
    const NEW_KEY = '-----BEGIN PRIVATE KEY-----\nclient-rotated\n-----END PRIVATE KEY-----\n';

    const dsn = () => `${base}?sslmode=verify-full&${rootCertParam()}&${clientCertParams()}`;

    type ClientCtor = new (config: pg.PoolConfig) => pg.Client;
    /** The pool constructs one client per physical connection from config.Client. */
    const newPoolClient = (config: pg.PoolConfig): pg.Client =>
      new (config.Client as unknown as ClientCtor)(config);
    const pems = (config: pg.PoolConfig) => {
      const ssl = config.ssl as { ca?: string; cert?: string; key?: string };
      return { ca: ssl.ca, cert: ssl.cert, key: ssl.key };
    };

    beforeEach(() => {
      // Stop at the point where pg would open a socket; the PEM reload happens before it.
      vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(function (
        this: pg.Client,
        callback?: (err: Error) => void
      ) {
        if (callback) {
          callback(undefined as unknown as Error);
          return;
        }
        return Promise.resolve();
      } as typeof pg.Client.prototype.connect);
    });

    it('installs a custom pool Client only when PEM files are configured', async () => {
      const withPems = await parser.parse(dsn());
      expect(withPems.Client).toBeDefined();
      const withoutPems = await parser.parse(`${base}?sslmode=require`);
      expect(withoutPems.Client).toBeUndefined();
    });

    it('re-reads rotated PEM files when a new connection is opened', async () => {
      const config = await parser.parse(dsn());
      // At parse time: verify-full with the CA and the client certificate loaded together
      expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: CA, cert: CERT, key: KEY });

      fs.writeFileSync(caPath, NEW_CA);
      fs.writeFileSync(certPath, NEW_CERT);
      fs.writeFileSync(keyPath, NEW_KEY);

      await newPoolClient(config).connect();
      // pg marks ssl.key non-enumerable when a Client is constructed, so
      // compare the fields explicitly rather than with toEqual.
      expect(pems(config)).toEqual({ ca: NEW_CA, cert: NEW_CERT, key: NEW_KEY });
      expect(pg.Client.prototype.connect).toHaveBeenCalledTimes(1);
    });

    it('fails the new connection, naming the file, when a PEM file cannot be read', async () => {
      const config = await parser.parse(dsn());
      fs.rmSync(keyPath);

      const err = await newPoolClient(config).connect().catch((e: unknown) => e as Error);
      expect((err as Error).name).toBe('FailedToReadCertificate');
      expect((err as Error).message).toContain(`Failed to read SSL client key at '${keyPath}'`);
      expect(pg.Client.prototype.connect).not.toHaveBeenCalled();
    });

    it('reports the failure through the callback form of connect as well', async () => {
      const config = await parser.parse(dsn());
      fs.rmSync(certPath);

      const err = await new Promise<Error>((resolve) => newPoolClient(config).connect(resolve));
      expect(err.message).toContain(`Failed to read SSL client certificate at '${certPath}'`);
      expect(pg.Client.prototype.connect).not.toHaveBeenCalled();
    });

    it('never publishes a half-rotated cert/key pair', async () => {
      const config = await parser.parse(dsn());
      fs.writeFileSync(certPath, NEW_CERT);
      fs.rmSync(keyPath);

      await expect(newPoolClient(config).connect()).rejects.toThrow('Failed to read SSL client key');
      // The pair in the pool config is still the one that was read together.
      expect(pems(config)).toEqual({ ca: CA, cert: CERT, key: KEY });
    });

    it('rejects a rotated key that is encrypted', async () => {
      const config = await parser.parse(dsn());
      fs.writeFileSync(keyPath, ENCRYPTED_KEY);

      await expect(newPoolClient(config).connect()).rejects.toThrow(
        'encrypted private keys are not supported'
      );
      expect(pg.Client.prototype.connect).not.toHaveBeenCalled();
    });
  });
});

describe('DSN Parser - query timeout and pool size', () => {
  it('PostgreSQL sets a server-side statement timeout before the client fallback, and pg PoolConfig.max', async () => {
    const parser = new PostgresConnector().dsnParser;
    const dsn = 'postgres://user:pass@localhost:5432/db';
    const config = await parser.parse(dsn, { queryTimeoutSeconds: 30, poolMaxConnections: 5 });

    expect(config.statement_timeout).toBe(30_000);
    expect(config.query_timeout).toBe(35_000);
    expect(config.max).toBe(5);
    // pg's default pool size stays in place when no maximum is configured
    expect((await parser.parse(dsn)).max).toBeUndefined();
  });

  it('MySQL maps the configured maximum to mysql2 connectionLimit', async () => {
    const parser = new MySQLConnector().dsnParser;
    const dsn = 'mysql://user:pass@localhost:3306/db';

    expect((await parser.parse(dsn, { poolMaxConnections: 5 })).connectionLimit).toBe(5);
    // mysql2's default pool size stays in place when no maximum is configured
    expect((await parser.parse(dsn)).connectionLimit).toBeUndefined();
  });
});

describe('DSN Parser - MySQL / MariaDB SSL Modes', () => {
  const mysqlParser = new MySQLConnector().dsnParser;
  const mariadbParser = new MariaDBConnector().dsnParser;
  const mysqlDsn = (query: string) => `mysql://user:pass@db.example.com:3306/db${query}`;
  const mariadbDsn = (query: string) => `mariadb://user:pass@db.example.com:3306/db${query}`;

  it.each([
    ['no sslmode', '', undefined],
    ['no sslmode but other parameters', '?charset=utf8mb4', undefined],
    ['sslmode=disable', '?sslmode=disable', undefined],
    ['sslmode=require', '?sslmode=require', { rejectUnauthorized: false }],
    ['the last of a repeated sslmode', '?sslmode=disable&sslmode=require', { rejectUnauthorized: false }],
  ])('should map %s to ssl = %j on both drivers', async (_label, query, ssl) => {
    expect((await mysqlParser.parse(mysqlDsn(query))).ssl).toEqual(ssl);
    expect((await mariadbParser.parse(mariadbDsn(query))).ssl).toEqual(ssl);
  });

  it('should verify the chain but not the host name for sslmode=verify-ca', async () => {
    // mysql2 checks the host name only with verifyIdentity
    expect((await mysqlParser.parse(mysqlDsn('?sslmode=verify-ca'))).ssl).toEqual({ rejectUnauthorized: true });

    // The mariadb driver checks it unless a checkServerIdentity is supplied
    const ssl = (await mariadbParser.parse(mariadbDsn('?sslmode=verify-ca'))).ssl as any;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity('other.example.com', {})).toBeUndefined();
  });

  it('should verify the chain and the host name for sslmode=verify-full', async () => {
    expect((await mysqlParser.parse(mysqlDsn('?sslmode=verify-full'))).ssl).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: true,
    });

    const ssl = (await mariadbParser.parse(mariadbDsn('?sslmode=verify-full'))).ssl as any;
    expect(ssl).toEqual({ rejectUnauthorized: true });
    expect(ssl.checkServerIdentity).toBeUndefined();
  });

  it.each(['prefer', 'allow', 'requier', 'VERIFY_IDENTITY', 'true'])(
    'should reject unsupported sslmode=%s',
    async (sslmode) => {
      const message = `Unsupported sslmode '${sslmode}'. Valid values: disable, require, verify-ca, verify-full`;
      await expect(mysqlParser.parse(mysqlDsn(`?sslmode=${sslmode}`))).rejects.toThrow(message);
      await expect(mariadbParser.parse(mariadbDsn(`?sslmode=${sslmode}`))).rejects.toThrow(message);
    }
  );

  it('should hand each parse its own ssl object', async () => {
    // Both drivers write defaults back onto the object they are given
    const first = await mysqlParser.parse(mysqlDsn('?sslmode=verify-full'));
    const second = await mysqlParser.parse(mysqlDsn('?sslmode=verify-full'));
    expect(first.ssl).not.toBe(second.ssl);
  });
});

describe('DSN Parser - AWS IAM Authentication', () => {
  const awsToken = 'mydb.abc123.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=myuser&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-east-1/rds-db/aws4_request&X-Amz-Date=20240101T000000Z&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123def456';
  const iamDsn = (scheme: string) =>
    `${scheme}://myuser:${encodeURIComponent(awsToken)}@mydb.abc123.us-east-1.rds.amazonaws.com:3306/mydb`;

  it('MySQL should detect AWS IAM token and configure cleartext plugin with SSL', async () => {
    const config = await new MySQLConnector().dsnParser.parse(iamDsn('mysql'));

    // Should auto-enable SSL for AWS IAM authentication
    expect(config.ssl).toEqual({ rejectUnauthorized: false });

    // mysql2 passes plugin metadata and the server's auth data; the cleartext
    // plugin ignores both and returns the password with a null terminator.
    const pluginFunc = config.authPlugins!.mysql_clear_password({} as any);
    const result = pluginFunc(Buffer.alloc(0)) as Buffer;
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe(awsToken + '\0');
  });

  it('MySQL should not configure cleartext plugin for normal passwords', async () => {
    const config = await new MySQLConnector().dsnParser.parse('mysql://myuser:regularpassword@localhost:3306/mydb');

    expect(config.authPlugins).toBeUndefined();
    expect(config.ssl).toBeUndefined();
  });

  it('MariaDB should detect AWS IAM token and auto-enable SSL', async () => {
    const config = await new MariaDBConnector().dsnParser.parse(iamDsn('mariadb'));

    // SSL should be auto-enabled for AWS IAM auth
    // MariaDB connector includes mysql_clear_password in default permitted plugins
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });
});

describe('DSN Parser - empty sslmode', () => {
  const generic = "Unsupported sslmode ''. Valid values: disable, require, verify-ca, verify-full";

  // These parsers read sslmode from the raw query string (rawQueryParamValues):
  // SafeURL drops a parameter with no value, so each of these used to look like
  // no sslmode at all and connected without TLS. SQL Server has its own check below.
  describe.each([
    ['PostgreSQL', new PostgresConnector().dsnParser, 'postgres://user:pass@localhost:5432/db', generic],
    ['MySQL', new MySQLConnector().dsnParser, 'mysql://user:pass@db.example.com:3306/db', generic],
    ['MariaDB', new MariaDBConnector().dsnParser, 'mariadb://user:pass@db.example.com:3306/db', generic],
    [
      'Oracle',
      new OracleConnector().dsnParser,
      'oracle://app:secret@db:2484/PROD',
      "Unsupported sslmode '' for Oracle. Supported: disable, require, verify-full",
    ],
    [
      'ClickHouse',
      new ClickHouseConnector().dsnParser,
      'clickhouse://reader:secret@ch:8123/analytics',
      "Unsupported sslmode '' for ClickHouse. Supported: disable, require, verify-full",
    ],
  ])('%s', (_name, parser, base, message) => {
    it.each([
      ['an empty value', '?sslmode='],
      ['a bare parameter', '?sslmode'],
      ['an empty value among other parameters', '?application_name=app&sslmode=&foo=bar'],
      ['an empty value after a valid one', '?sslmode=require&sslmode='],
      ['an empty value before a valid one', '?sslmode=&sslmode=require'],
    ])('rejects %s instead of connecting unencrypted', async (_, query) => {
      await expect(parser.parse(`${base}${query}`)).rejects.toThrow(message);
    });
  });
});

describe('DSN Parser - SQL Server SSL/TLS Configuration', () => {
  const parser = new SQLServerConnector().dsnParser;

  it.each([
    ['no sslmode (defaults to unencrypted)', '', false, false],
    ['sslmode=disable', '?sslmode=disable', false, false],
    ['sslmode=require', '?sslmode=require', true, true],
    ['sslmode=verify-full', '?sslmode=verify-full', true, false],
  ])('should map %s to encrypt=%s / trustServerCertificate=%s', async (_label, query, encrypt, trust) => {
    const config = await parser.parse(`sqlserver://user:pass@localhost:1433/db${query}`);

    expect(config.options?.encrypt).toBe(encrypt);
    expect(config.options?.trustServerCertificate).toBe(trust);
    // No instanceName in the DSN: must stay unset (backward compatibility)
    expect(config.options?.instanceName).toBeUndefined();
    expect(config.server).toBe('localhost');
    expect(config.port).toBe(1433);
    // Plain SQL authentication: credentials at the top level, no NTLM block
    expect(config.user).toBe('user');
    expect(config.password).toBe('pass');
    expect(config.authentication).toBeUndefined();
  });

  it.each([
    'sslmode=verify_ful',
    'sslmode=verify-ca',
    'sslmode=%20',
    'sslmode',
    'sslmode=',
    'sslmode=verify-full=extra',
    'sslmode=verify%3Dfull',
    'sslmode=%',
    'sslmode=%C3%28',
    '%73slmode=',
    '%73slmode=verify_ful',
    'sslmode=verify-full&sslmode=verify-full',
    'sslmode=verify-full&sslmode=disable',
    'sslmode=verify_ful&sslmode=disable',
    'sslmode=verify-full&sslmode=',
    'sslmode=&sslmode=verify-full',
    'sslmode=verify-full&%73slmode=disable',
    '%73slmode=verify%2Dfull&sslmode=disable',
  ])('should reject invalid sslmode query %s with a fixed error', async (query) => {
    await expect(
      parser.parse(`sqlserver://user:pass@localhost:1433/db?${query}`)
    ).rejects.toMatchObject({
      message: 'Failed to parse SQL Server DSN: Invalid sslmode. Specify exactly one value: disable, require, verify-full',
    });
  });

  it.each([
    ['p@ss#word:&=+', 'p@ss#word:&=+'],
    ['p%3Fsslmode%3Ddisable%26sslmode%3Dverify_ful', 'p?sslmode=disable&sslmode=verify_ful'],
  ])('should preserve password %s with an encoded sslmode and a named instance', async (password, decodedPassword) => {
    const config = await parser.parse(
      `sqlserver://user%40domain:${password}@localhost:1433/db?%73slmode=verify%2Dfull&instanceName=ENV1`,
      { connectionTimeoutSeconds: 15, queryTimeoutSeconds: 30 }
    );

    expect(config).toMatchObject({
      user: 'user@domain',
      password: decodedPassword,
      server: 'localhost',
      port: 1433,
      database: 'db',
      options: {
        encrypt: true,
        trustServerCertificate: false,
        instanceName: 'ENV1',
        connectTimeout: 15000,
        requestTimeout: 30000,
      },
    });
  });
});

describe('DSN Parser - SQL Server applicationIntent', () => {
  const parser = new SQLServerConnector().dsnParser;

  it.each([
    ['ReadOnly', true],
    ['readonly', true],
    ['ReadWrite', false],
    ['READWRITE', false],
  ])('should map applicationIntent=%s to readOnlyIntent=%s', async (intent, expected) => {
    const config = await parser.parse(
      `sqlserver://user:pass@mi.database.windows.net:1433/db?sslmode=verify-full&applicationIntent=${intent}`
    );

    expect(config.options?.readOnlyIntent).toBe(expected);
    expect(config.options?.encrypt).toBe(true);
  });

  it.each(['ApplicationIntent', 'APPLICATIONINTENT'])('should accept the %s key spelling', async (key) => {
    const config = await parser.parse(`sqlserver://user:pass@localhost:1433/db?${key}=ReadOnly`);

    expect(config.options?.readOnlyIntent).toBe(true);
  });

  it('should leave readOnlyIntent unset when applicationIntent is absent', async () => {
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/db');

    expect(config.options).not.toHaveProperty('readOnlyIntent');
  });

  it.each(['applicationIntent=', 'applicationIntent=Read-Only', 'applicationIntent=secondary', 'applicationIntent=ReadOnly&applicationIntent=ReadWrite', 'applicationIntent=ReadOnly&ApplicationIntent=ReadOnly'])('should reject %j', async (intent) => {
    await expect(
      parser.parse(`sqlserver://user:pass@localhost:1433/db?${intent}`)
    ).rejects.toThrow(/Invalid applicationIntent/);
  });
});

describe('DSN Parser - SQL Server NTLM Authentication', () => {
  const connector = new SQLServerConnector();
  const parser = connector.dsnParser;

  it('should configure NTLM authentication and preserve other options', async () => {
    const dsn = 'sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?authentication=ntlm&domain=CORP&sslmode=require&instanceName=PROD';

    const config = await parser.parse(dsn);

    expect(config.authentication).toEqual({
      type: 'ntlm',
      options: {
        domain: 'CORP',
        userName: 'jsmith',
        password: 'secret',
      },
    });
    // Credentials should only be in authentication object, not at top level
    expect(config.user).toBeUndefined();
    expect(config.password).toBeUndefined();
    expect(config.options?.encrypt).toBe(true);
    expect(config.options?.trustServerCertificate).toBe(true);
    expect(config.options?.instanceName).toBe('PROD');
  });

  it('should throw error when authentication=ntlm but domain is missing', async () => {
    const dsn = 'sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?authentication=ntlm';

    await expect(parser.parse(dsn)).rejects.toThrow("NTLM authentication requires 'domain' parameter");
  });

  it('should throw error when domain is provided without authentication=ntlm', async () => {
    const dsn = 'sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?domain=CORP';

    await expect(parser.parse(dsn)).rejects.toThrow("Parameter 'domain' requires 'authentication=ntlm'");
  });
});

describe('DSN Parser - SQL Server Entra service principal authentication', () => {
  const connector = new SQLServerConnector();
  const parser = connector.dsnParser;
  const dsn = 'sqlserver://client-id@example.datawarehouse.fabric.microsoft.com:1433/db?authentication=entra-service-principal&sslmode=require';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should configure service principal authentication from the environment', async () => {
    vi.stubEnv('AZURE_CLIENT_ID', 'client-id');
    vi.stubEnv('AZURE_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('AZURE_TENANT_ID', 'tenant-id');

    const config = await parser.parse(dsn);

    expect(config.authentication).toEqual({
      type: 'azure-active-directory-service-principal-secret',
      options: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
    });
    // Fabric rejects SET XACT_ABORT during connection initialization
    expect(config.options?.abortTransactionOnError).toBeNull();
    expect(config.options?.encrypt).toBe(true);
  });

  it('should list every missing environment variable', async () => {
    vi.stubEnv('AZURE_CLIENT_ID', 'client-id');
    vi.stubEnv('AZURE_CLIENT_SECRET', '');
    vi.stubEnv('AZURE_TENANT_ID', '');

    await expect(parser.parse(dsn)).rejects.toThrow(
      'requires environment variables: AZURE_CLIENT_SECRET, AZURE_TENANT_ID'
    );
  });
});

describe('DSN Parser - missing database component', () => {
  describe.each([
    { label: 'MySQL', connector: () => new MySQLConnector(), scheme: 'mysql' },
    { label: 'MariaDB', connector: () => new MariaDBConnector(), scheme: 'mariadb' },
  ])('$label', ({ label, connector, scheme }) => {
    const parser = connector().dsnParser;

    it.each([
      { form: 'trailing slash', dsn: `${scheme}://user:pass@localhost:3306/` },
      { form: 'no path', dsn: `${scheme}://user:pass@localhost:3306` },
      { form: 'query string only', dsn: `${scheme}://user:pass@localhost:3306/?sslmode=disable` },
    ])('rejects a DSN with $form and points at the TOML config for multi-database setups', async ({ dsn }) => {
      const err = await parser.parse(dsn).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(`${label} DSN must name a database`);
      expect((err as Error).message).toMatch(/https:\/\/dbhub\.ai\/config\/toml/);
    });

    it('does not leak the password in the error message', async () => {
      // The error echoes the DSN back, so it must be obfuscated first
      await expect(parser.parse(`${scheme}://user:hunter2@localhost:3306/`)).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('hunter2'),
        })
      );
    });
  });
});

describe('DSN Parser - ClickHouse', () => {
  const parser = new ClickHouseConnector().dsnParser;

  it('points the client at the HTTP interface, with credentials decoded', async () => {
    expect(await parser.parse('clickhouse://reader:p%40ss%3Aw%2Frd@ch.example.com:8124/analytics')).toEqual({
      url: 'http://ch.example.com:8124',
      username: 'reader',
      password: 'p@ss:w/rd',
      database: 'analytics',
      sslmode: 'disable',
    });
  });

  it("falls back to the server's defaults: user default, no password, database default, port 8123", async () => {
    expect(await parser.parse('clickhouse://localhost')).toEqual({
      url: 'http://localhost:8123',
      username: 'default',
      password: '',
      database: 'default',
      sslmode: 'disable',
    });
    expect(await parser.parse('clickhouse://default:@localhost/')).toMatchObject({
      username: 'default',
      password: '',
      database: 'default',
    });
  });

  it.each([
    ['require', 'https://x.clickhouse.cloud:8443'],
    ['verify-full', 'https://x.clickhouse.cloud:8443'],
    ['disable', 'http://x.clickhouse.cloud:8123'],
  ])('uses the port that goes with sslmode=%s when none is given', async (sslmode, url) => {
    expect(await parser.parse(`clickhouse://default:pw@x.clickhouse.cloud/default?sslmode=${sslmode}`)).toMatchObject({
      url,
      sslmode,
    });
  });

  it('keeps an explicit port whatever the sslmode, and the last sslmode given', async () => {
    expect(
      await parser.parse('clickhouse://default:pw@ch:9000/default?sslmode=disable&sslmode=verify-full')
    ).toMatchObject({ url: 'https://ch:9000', sslmode: 'verify-full' });
  });

  it('brackets an IPv6 host in the URL', async () => {
    expect(await parser.parse('clickhouse://default:pw@[::1]:8123/default')).toMatchObject({
      url: 'http://[::1]:8123',
    });
  });

  it.each([
    ['verify-ca, which the HTTP client cannot do', 'clickhouse://u:p@ch/db?sslmode=verify-ca', "Unsupported sslmode 'verify-ca' for ClickHouse"],
    ['an unknown sslmode', 'clickhouse://u:p@ch/db?sslmode=on', "Unsupported sslmode 'on' for ClickHouse"],
    ['another scheme', 'https://u:p@ch:8443/db', 'Invalid ClickHouse DSN format'],
  ])('rejects %s', async (_label, dsn, message) => {
    await expect(parser.parse(dsn)).rejects.toThrow(message);
  });

  it('does not echo the password when the DSN is rejected', async () => {
    await expect(parser.parse('clickhous://reader:hunter2@ch/db')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') })
    );
  });
});

describe('DSN Parser - Oracle', () => {
  const parser = new OracleConnector().dsnParser;

  it('builds an Easy Connect string from host, port and service name', async () => {
    // The password is URL-encoded in the DSN and handed to the driver decoded
    const config = await parser.parse('oracle://app:p%40ss%3Aw%2Frd@db.example.com:1521/FREEPDB1');
    expect(config.pool).toMatchObject({
      user: 'app',
      password: 'p@ss:w/rd',
      connectString: 'db.example.com:1521/FREEPDB1',
      program: 'dbhub',
      poolMin: 0,
      poolMax: 4,
    });
    expect(config.pool.connectTimeout).toBeUndefined();
    expect(config.pool.sslServerDNMatch).toBeUndefined();
    expect(config.callTimeoutMs).toBeUndefined();
  });

  it('defaults the port to 1521', async () => {
    const config = await parser.parse('oracle://app:secret@db/FREEPDB1');
    expect(config.pool.connectString).toBe('db:1521/FREEPDB1');
  });

  it('uses a connect descriptor for ?sid=', async () => {
    const config = await parser.parse('oracle://app:secret@db:1522/?sid=ORCL');
    expect(config.pool.connectString).toBe(
      '(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1522))(CONNECT_DATA=(SID=ORCL)))'
    );
  });

  it('switches to TCPS for sslmode=require without DN matching', async () => {
    const config = await parser.parse('oracle://app:secret@db:2484/PROD?sslmode=require');
    expect(config.pool.connectString).toBe('tcps://db:2484/PROD');
    expect(config.pool.sslServerDNMatch).toBe(false);
    // Wallet attributes stay unset when not given
    expect(config.pool.walletLocation).toBeUndefined();
    expect(config.pool.walletPassword).toBeUndefined();
  });

  it('switches to TCPS with DN matching for sslmode=verify-full, including the SID form', async () => {
    const service = await parser.parse('oracle://app:secret@db:2484/PROD?sslmode=verify-full');
    expect(service.pool.connectString).toBe('tcps://db:2484/PROD');
    expect(service.pool.sslServerDNMatch).toBe(true);

    const sid = await parser.parse('oracle://app:secret@db:2484/?sid=ORCL&sslmode=verify-full');
    expect(sid.pool.connectString).toContain('(PROTOCOL=TCPS)');
    expect(sid.pool.sslServerDNMatch).toBe(true);
  });

  it('maps connection timeout, query timeout and pool size from ConnectorConfig', async () => {
    const config = await parser.parse('oracle://app:secret@db:1521/FREEPDB1', {
      connectionTimeoutSeconds: 15,
      queryTimeoutSeconds: 30,
      poolMaxConnections: 8,
    });
    expect(config.pool.connectTimeout).toBe(15);
    expect(config.pool.poolMax).toBe(8);
    expect(config.callTimeoutMs).toBe(30000);
  });

  it('passes a PEM wallet for mutual TLS', async () => {
    const config = await parser.parse(
      'oracle://app:secret@adb.example.com:1522/svc_tp?sslmode=require&wallet_location=%2Fopt%2Fwallet&wallet_password=w%40llet'
    );
    expect(config.pool.connectString).toBe('tcps://adb.example.com:1522/svc_tp');
    expect(config.pool.walletLocation).toBe('/opt/wallet');
    expect(config.pool.walletPassword).toBe('w@llet');
    expect(config.pool.sslServerDNMatch).toBe(false);
    expect(config.pool.sslServerCertDN).toBeUndefined();
  });

  it('expands ~/ in wallet_location', async () => {
    const config = await parser.parse(
      'oracle://app:secret@adb.example.com:1522/svc_tp?sslmode=require&wallet_location=~%2Fwallets%2Fmydb'
    );
    expect(config.pool.walletLocation).toBe(path.join(os.homedir(), 'wallets/mydb'));
  });

  it('accepts a server certificate DN and wallet password written without percent-encoding', async () => {
    const config = await parser.parse(
      'oracle://app:secret@10.0.0.5:1522/svc_tp?sslmode=require&wallet_location=%2Fw&wallet_password=abc==&ssl_server_cert_dn=CN=db,O=Acme'
    );
    expect(config.pool.walletPassword).toBe('abc==');
    expect(config.pool.sslServerCertDN).toBe('CN=db,O=Acme');
  });

  it('checks an explicit server certificate DN even with sslmode=require', async () => {
    const dn = 'CN=adb.eu-frankfurt-1.oraclecloud.com, O=Oracle Corporation, L=Redwood City, ST=California, C=US';
    const config = await parser.parse(
      `oracle://app:secret@10.0.0.5:1522/svc_tp?sslmode=require&ssl_server_cert_dn=${encodeURIComponent(dn)}`
    );
    expect(config.pool.sslServerCertDN).toBe(dn);
    expect(config.pool.sslServerDNMatch).toBe(true);
  });

  it.each([
    ['oracle://app:secret@db:1522/X?wallet_location=%2Fw', 'require sslmode=require or sslmode=verify-full'],
    ['oracle://app:secret@db:1522/X?sslmode=disable&ssl_server_cert_dn=CN%3Dx', 'require sslmode=require or sslmode=verify-full'],
    ['oracle://app:secret@db:1522/X?sslmode=require&wallet_password=x', 'wallet_password requires wallet_location'],
  ])('rejects invalid wallet options in %s', async (dsn, message) => {
    await expect(parser.parse(dsn)).rejects.toThrow(message);
  });

  it.each([
    ['oracle://app:secret@db:1521/X?sslmode=verify-ca', "Unsupported sslmode 'verify-ca'"],
    ['oracle://app:secret@db:1521/', 'must include a service name'],
    ['postgres://app:secret@db:5432/X', 'Invalid Oracle DSN format'],
  ])('rejects %s', async (dsn, message) => {
    await expect(parser.parse(dsn)).rejects.toThrow(message);
  });

  it('applies the last sslmode when it is given more than once', async () => {
    const config = await parser.parse('oracle://app:secret@db:2484/PROD?sslmode=disable&sslmode=require');
    expect(config.pool.connectString).toContain('tcps://');
  });
});
