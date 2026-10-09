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

/** Write a PEM fixture into a temp dir and return its path. */
function writeTempPem(dir: string, name: string, pem: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, pem);
  return file;
}

describe('DSN Parser - PostgreSQL SSL Modes', () => {
  const connector = new PostgresConnector();
  const parser = connector.dsnParser;
  const CA = '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n';
  let tempDir: string;
  let certPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-ssl-test-'));
    certPath = writeTempPem(tempDir, 'ca-bundle.pem', CA);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should set ssl = false for sslmode=disable', async () => {
    const config = await parser.parse('postgres://user:pass@localhost:5432/db?sslmode=disable');
    expect(config.ssl).toBe(false);
  });

  it('should set rejectUnauthorized = false for sslmode=require', async () => {
    const config = await parser.parse('postgres://user:pass@localhost:5432/db?sslmode=require');
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('should set rejectUnauthorized = true and skip hostname check for sslmode=verify-ca', async () => {
    const config = await parser.parse('postgres://user:pass@localhost:5432/db?sslmode=verify-ca');
    const ssl = config.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(typeof ssl.checkServerIdentity).toBe('function');
    expect((ssl.checkServerIdentity as Function)()).toBeUndefined();
  });

  it('should set rejectUnauthorized = true and verify hostname for sslmode=verify-full', async () => {
    const config = await parser.parse('postgres://user:pass@localhost:5432/db?sslmode=verify-full');
    const ssl = config.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity).toBeUndefined();
  });

  it('should read CA cert file for sslmode=verify-full with sslrootcert', async () => {
    const dsn = `postgres://user:pass@localhost:5432/db?sslmode=verify-full&sslrootcert=${encodeURIComponent(certPath)}`;
    const config = await parser.parse(dsn);
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: CA });
  });

  it('should expand ~ in sslrootcert path', async () => {
    const mockHomedir = vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    writeTempPem(tempDir, 'ca.pem', 'test-ca-content');

    try {
      const dsn = `postgres://user:pass@localhost:5432/db?sslmode=verify-ca&sslrootcert=${encodeURIComponent('~/ca.pem')}`;
      const config = await parser.parse(dsn);
      const ssl = config.ssl as Record<string, unknown>;
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.ca).toBe('test-ca-content');
    } finally {
      mockHomedir.mockRestore();
    }
  });

  it('should throw when sslrootcert points to nonexistent file', async () => {
    const dsn = 'postgres://user:pass@localhost:5432/db?sslmode=verify-ca&sslrootcert=/nonexistent/ca.pem';
    await expect(parser.parse(dsn)).rejects.toThrow("Failed to read SSL root certificate at '/nonexistent/ca.pem'");
  });

  it.each([
    { sslmode: 'require', got: 'require' },
    { sslmode: 'disable', got: 'disable' },
    { sslmode: undefined, got: 'not set' },
  ])('should reject sslrootcert when sslmode is $got', async ({ sslmode, got }) => {
    const query = sslmode === undefined ? '' : `sslmode=${sslmode}&`;
    const dsn = `postgres://user:pass@localhost:5432/db?${query}sslrootcert=${encodeURIComponent(certPath)}`;
    await expect(parser.parse(dsn)).rejects.toThrow(
      `sslrootcert requires sslmode 'verify-ca' or 'verify-full' (got '${got}')`
    );
  });

  it('should leave ssl unset when sslmode is not set', async () => {
    const config = await parser.parse('postgres://user:pass@localhost:5432/db');
    expect(config.ssl).toBeUndefined();
  });

  it.each(['prefer', 'allow', 'verify_full', 'true'])(
    'should reject unsupported sslmode=%s',
    async (sslmode) => {
      await expect(
        parser.parse(`postgres://user:pass@localhost:5432/db?sslmode=${sslmode}`)
      ).rejects.toThrow(
        `Unsupported sslmode '${sslmode}'. Valid values: disable, require, verify-ca, verify-full`
      );
    }
  );
});

describe('DSN Parser - PostgreSQL client certificate (sslcert/sslkey)', () => {
  const connector = new PostgresConnector();
  const parser = connector.dsnParser;
  let tempDir: string;
  let caPath: string;
  let certPath: string;
  let keyPath: string;
  const CA = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n';
  const CERT = '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n';
  const KEY = '-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----\n';

  const base = 'postgres://user:pass@localhost:5432/db';
  const clientCertParams = () =>
    `sslcert=${encodeURIComponent(certPath)}&sslkey=${encodeURIComponent(keyPath)}`;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-clientcert-test-'));
    caPath = writeTempPem(tempDir, 'ca.pem', CA);
    certPath = writeTempPem(tempDir, 'client.crt', CERT);
    keyPath = writeTempPem(tempDir, 'client.key', KEY);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

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

  it('should load cert and key alongside sslrootcert with sslmode=verify-full', async () => {
    const config = await parser.parse(
      `${base}?sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}&${clientCertParams()}`
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: CA, cert: CERT, key: KEY });
  });

  it('should expand ~ in sslcert and sslkey paths', async () => {
    const mockHomedir = vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    try {
      const config = await parser.parse(
        `${base}?sslmode=require&sslcert=${encodeURIComponent('~/client.crt')}&sslkey=${encodeURIComponent('~/client.key')}`
      );
      expect(config.ssl).toEqual({ rejectUnauthorized: false, cert: CERT, key: KEY });
    } finally {
      mockHomedir.mockRestore();
    }
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
    ['PKCS#8', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----\n'],
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

describe('DSN Parser - PostgreSQL certificate rotation (sslrootcert/sslcert/sslkey)', () => {
  const parser = new PostgresConnector().dsnParser;
  let tempDir: string;
  let caPath: string;
  let certPath: string;
  let keyPath: string;
  const CA = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n';
  const CERT = '-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----\n';
  const KEY = '-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----\n';
  const NEW_CA = '-----BEGIN CERTIFICATE-----\nca-rotated\n-----END CERTIFICATE-----\n';
  const NEW_CERT = '-----BEGIN CERTIFICATE-----\nclient-rotated\n-----END CERTIFICATE-----\n';
  const NEW_KEY = '-----BEGIN PRIVATE KEY-----\nclient-rotated\n-----END PRIVATE KEY-----\n';
  const ENCRYPTED_KEY =
    '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----\n';

  const dsn = () =>
    'postgres://user:pass@localhost:5432/db?sslmode=verify-full' +
    `&sslrootcert=${encodeURIComponent(caPath)}` +
    `&sslcert=${encodeURIComponent(certPath)}&sslkey=${encodeURIComponent(keyPath)}`;

  type ClientCtor = new (config: pg.PoolConfig) => pg.Client;
  /** The pool constructs one client per physical connection from config.Client. */
  const newPoolClient = (config: pg.PoolConfig): pg.Client =>
    new (config.Client as unknown as ClientCtor)(config);
  const pems = (config: pg.PoolConfig) => {
    const ssl = config.ssl as { ca?: string; cert?: string; key?: string };
    return { ca: ssl.ca, cert: ssl.cert, key: ssl.key };
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-certrotation-test-'));
    caPath = writeTempPem(tempDir, 'ca.pem', CA);
    certPath = writeTempPem(tempDir, 'client.crt', CERT);
    keyPath = writeTempPem(tempDir, 'client.key', KEY);
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

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('installs a custom pool Client only when PEM files are configured', async () => {
    const withPems = await parser.parse(dsn());
    expect(withPems.Client).toBeDefined();
    const withoutPems = await parser.parse('postgres://user:pass@localhost:5432/db?sslmode=require');
    expect(withoutPems.Client).toBeUndefined();
  });

  it('re-reads rotated PEM files when a new connection is opened', async () => {
    const config = await parser.parse(dsn());
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

describe('DSN Parser - PostgreSQL query timeout', () => {
  it('configures a server-side statement timeout before the client fallback', async () => {
    const parser = new PostgresConnector().dsnParser;
    const config = await parser.parse('postgres://user:pass@localhost:5432/db', {
      queryTimeoutSeconds: 30,
    });

    expect(config.statement_timeout).toBe(30_000);
    expect(config.query_timeout).toBe(35_000);
  });
});

describe('DSN Parser - PostgreSQL pool size', () => {
  it('maps the configured maximum to pg PoolConfig.max', async () => {
    const parser = new PostgresConnector().dsnParser;
    const config = await parser.parse('postgres://user:pass@localhost:5432/db', {
      poolMaxConnections: 5,
    });

    expect(config.max).toBe(5);
  });

  it('leaves pg defaults unchanged when no maximum is configured', async () => {
    const parser = new PostgresConnector().dsnParser;
    const config = await parser.parse('postgres://user:pass@localhost:5432/db');

    expect(config.max).toBeUndefined();
  });
});

describe('DSN Parser - AWS IAM Authentication', () => {
  describe('MySQL', () => {
    const connector = new MySQLConnector();
    const parser = connector.dsnParser;

    it('should detect AWS IAM token and configure cleartext plugin with SSL', async () => {
      const awsToken = 'mydb.abc123.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=myuser&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-east-1/rds-db/aws4_request&X-Amz-Date=20240101T000000Z&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123def456';
      const dsn = `mysql://myuser:${encodeURIComponent(awsToken)}@mydb.abc123.us-east-1.rds.amazonaws.com:3306/mydb`;

      const config = await parser.parse(dsn);

      // Should have authPlugins configured with cleartext plugin
      expect(config.authPlugins).toBeDefined();
      expect(config.authPlugins?.mysql_clear_password).toBeDefined();

      // Should auto-enable SSL for AWS IAM authentication
      expect(config.ssl).toEqual({ rejectUnauthorized: false });

      // Plugin should return password with null terminator
      if (config.authPlugins?.mysql_clear_password) {
        const pluginFunc = config.authPlugins.mysql_clear_password();
        const result = pluginFunc();
        expect(result).toBeInstanceOf(Buffer);
        expect(result.toString()).toBe(awsToken + '\0');
      }
    });

    it('should not configure cleartext plugin for normal passwords', async () => {
      const dsn = 'mysql://myuser:regularpassword@localhost:3306/mydb';

      const config = await parser.parse(dsn);

      expect(config.authPlugins).toBeUndefined();
      expect(config.ssl).toBeUndefined();
    });
  });

  describe('MariaDB', () => {
    const connector = new MariaDBConnector();
    const parser = connector.dsnParser;

    it('should detect AWS IAM token and auto-enable SSL', async () => {
      const awsToken = 'mydb.abc123.us-east-1.rds.amazonaws.com:3306/?Action=connect&DBUser=myuser&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-east-1/rds-db/aws4_request&X-Amz-Date=20240101T000000Z&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123def456';
      const dsn = `mariadb://myuser:${encodeURIComponent(awsToken)}@mydb.abc123.us-east-1.rds.amazonaws.com:3306/mydb`;

      const config = await parser.parse(dsn);

      // SSL should be auto-enabled for AWS IAM auth
      // MariaDB connector includes mysql_clear_password in default permitted plugins
      expect(config.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('should not auto-enable SSL for normal passwords', async () => {
      const dsn = 'mariadb://myuser:regularpassword@localhost:3306/mydb';

      const config = await parser.parse(dsn);

      expect(config.ssl).toBeUndefined();
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

  it('should not configure NTLM for normal SQL authentication', async () => {
    const dsn = 'sqlserver://sa:password@localhost:1433/mydb';

    const config = await parser.parse(dsn);

    expect(config.authentication).toBeUndefined();
    expect(config.user).toBe('sa');
    expect(config.password).toBe('password');
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

    it('still accepts a DSN that names a database', async () => {
      const config = await parser.parse(`${scheme}://user:pass@localhost:3306/mydb`);
      expect(config.database).toBe('mydb');
    });
  });
});

describe('DSN Parser - Oracle', () => {
  const parser = new OracleConnector().dsnParser;

  it('builds an Easy Connect string from host, port and service name', async () => {
    const config = await parser.parse('oracle://app:secret@db.example.com:1521/FREEPDB1');
    expect(config.pool).toMatchObject({
      user: 'app',
      password: 'secret',
      connectString: 'db.example.com:1521/FREEPDB1',
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

  it('decodes URL-encoded credentials', async () => {
    const config = await parser.parse('oracle://app:p%40ss%3Aw%2Frd@db:1521/FREEPDB1');
    expect(config.pool.password).toBe('p@ss:w/rd');
  });

  it.each([
    ['oracle://app:secret@db:1521/X?sslmode=verify-ca', "Unsupported sslmode 'verify-ca'"],
    ['oracle://app:secret@db:1521/', 'must include a service name'],
    ['postgres://app:secret@db:5432/X', 'Invalid Oracle DSN format'],
  ])('rejects %s', async (dsn, message) => {
    await expect(parser.parse(dsn)).rejects.toThrow(message);
  });
});
