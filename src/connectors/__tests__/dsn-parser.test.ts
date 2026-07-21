import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PostgresConnector } from '../postgres/index.js';
import { MySQLConnector } from '../mysql/index.js';
import { MariaDBConnector } from '../mariadb/index.js';
import { SQLServerConnector } from '../sqlserver/index.js';
import { HanaConnector } from '../hana/index.js';

describe('DSN Parser - PostgreSQL SSL Modes', () => {
  const connector = new PostgresConnector();
  const parser = connector.dsnParser;
  let tempDir: string;
  let certPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-ssl-test-'));
    certPath = path.join(tempDir, 'ca-bundle.pem');
    fs.writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
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

  it('should read CA cert file for sslmode=verify-ca with sslrootcert', async () => {
    const dsn = `postgres://user:pass@localhost:5432/db?sslmode=verify-ca&sslrootcert=${encodeURIComponent(certPath)}`;
    const config = await parser.parse(dsn);
    const ssl = config.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBe('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n');
    expect(typeof ssl.checkServerIdentity).toBe('function');
  });

  it('should read CA cert file for sslmode=verify-full with sslrootcert', async () => {
    const dsn = `postgres://user:pass@localhost:5432/db?sslmode=verify-full&sslrootcert=${encodeURIComponent(certPath)}`;
    const config = await parser.parse(dsn);
    expect(config.ssl).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n',
    });
  });

  it('should expand ~ in sslrootcert path', async () => {
    const mockHomedir = vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    fs.writeFileSync(path.join(tempDir, 'ca.pem'), 'test-ca-content');

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

  it('should ignore sslrootcert when sslmode=require', async () => {
    const dsn = `postgres://user:pass@localhost:5432/db?sslmode=require&sslrootcert=${encodeURIComponent(certPath)}`;
    const config = await parser.parse(dsn);
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('should ignore sslrootcert when sslmode=disable', async () => {
    const dsn = `postgres://user:pass@localhost:5432/db?sslmode=disable&sslrootcert=${encodeURIComponent(certPath)}`;
    const config = await parser.parse(dsn);
    expect(config.ssl).toBe(false);
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

describe('DSN Parser - SQL Server NTLM Authentication', () => {
  const connector = new SQLServerConnector();
  const parser = connector.dsnParser;

  it('should configure NTLM authentication when authentication=ntlm and domain are provided', async () => {
    const dsn = 'sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?authentication=ntlm&domain=CORP';

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
  });

  it('should preserve other options when using NTLM authentication', async () => {
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
    ])('rejects a DSN with $form', async ({ dsn }) => {
      await expect(parser.parse(dsn)).rejects.toThrow(`${label} DSN must name a database`);
    });

    it('points the user at the TOML config for multi-database setups', async () => {
      await expect(parser.parse(`${scheme}://user:pass@localhost:3306/`)).rejects.toThrow(
        /https:\/\/dbhub\.ai\/config\/toml/
      );
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

describe('DSN Parser - SAP HANA', () => {
  const parser = new HanaConnector().dsnParser;

  it('parses host, port, user and password', async () => {
    const config = await parser.parse('hana://user:pass@hana.example.com:30015');
    expect(config.host).toBe('hana.example.com');
    expect(config.port).toBe(30015);
    expect(config.uid).toBe('user');
    expect(config.pwd).toBe('pass');
  });

  it('defaults the port to 30015 when omitted', async () => {
    const config = await parser.parse('hana://user:pass@hana.example.com');
    expect(config.port).toBe(30015);
  });

  it('reads the tenant database from the path segment', async () => {
    const config = await parser.parse('hana://user:pass@host:30015/H00');
    expect(config.databaseName).toBe('H00');
  });

  it('reads the tenant database from the databaseName query param', async () => {
    const config = await parser.parse('hana://user:pass@host:30041?databaseName=TENANT1');
    expect(config.databaseName).toBe('TENANT1');
  });

  it('maps sslmode=disable to encrypt=false', async () => {
    const config = await parser.parse('hana://user:pass@host:30015?sslmode=disable');
    expect(config.encrypt).toBe(false);
  });

  it('maps sslmode=require to encrypt=true without certificate validation', async () => {
    const config = await parser.parse('hana://user:pass@host:30015?sslmode=require');
    expect(config.encrypt).toBe(true);
    expect(config.sslValidateCertificate).toBe(false);
  });

  it('maps sslmode=verify-full to encrypt=true with certificate validation', async () => {
    const config = await parser.parse('hana://user:pass@host:30015?sslmode=verify-full');
    expect(config.encrypt).toBe(true);
    expect(config.sslValidateCertificate).toBe(true);
  });

  it('rejects contradictory TLS config (verify-full with encrypt=false)', async () => {
    await expect(
      parser.parse('hana://user:pass@host:30015?sslmode=verify-full&encrypt=false')
    ).rejects.toThrow(/Contradictory TLS config/);
  });

  it('parses encrypt case-insensitively', async () => {
    const config = await parser.parse('hana://user:pass@host:30015?encrypt=TRUE');
    expect(config.encrypt).toBe(true);
  });

  it('rejects an invalid boolean for encrypt', async () => {
    await expect(
      parser.parse('hana://user:pass@host:30015?encrypt=yes')
    ).rejects.toThrow(/Invalid boolean/);
  });

  it('rejects an unknown sslmode', async () => {
    await expect(
      parser.parse('hana://user:pass@host:30015?sslmode=bogus')
    ).rejects.toThrow(/Invalid sslmode/);
  });

  it('maps connectionTimeoutSeconds to connectTimeout in milliseconds', async () => {
    const config = await parser.parse('hana://user:pass@host:30015', {
      connectionTimeoutSeconds: 15,
    });
    expect(config.connectTimeout).toBe(15000);
  });

  it('accepts its own sample DSN as valid', () => {
    expect(parser.isValidDSN(parser.getSampleDSN())).toBe(true);
  });

  it('only accepts the hana:// scheme', () => {
    expect(parser.isValidDSN('hana://u:p@h:30015')).toBe(true);
    expect(parser.isValidDSN('hdb://u:p@h:30015')).toBe(false);
  });

  it('rejects a non-HANA DSN', async () => {
    await expect(parser.parse('mysql://user:pass@host:3306/db')).rejects.toThrow(
      'Invalid SAP HANA DSN format'
    );
  });

  it('does not leak the password in the error message', async () => {
    await expect(parser.parse('postgres://user:hunter2@host:5432/db')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') })
    );
  });
});
