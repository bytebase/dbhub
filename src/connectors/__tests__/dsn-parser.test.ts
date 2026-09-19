import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PostgresConnector } from '../postgres/index.js';
import { MySQLConnector } from '../mysql/index.js';
import { MariaDBConnector } from '../mariadb/index.js';
import { SQLServerConnector } from '../sqlserver/index.js';
import { OracleConnector } from '../oracle/index.js';

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

describe('DSN Parser - SQL Server Named Instance Configuration', () => {
  it('should parse instanceName from query parameter', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb?instanceName=ENV1');

    expect(config.options?.instanceName).toBe('ENV1');
    expect(config.server).toBe('localhost');
    expect(config.port).toBe(1433);
    expect(config.database).toBe('testdb');
  });

  it('should parse instanceName with other query parameters', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb?instanceName=ENV2&sslmode=disable');

    expect(config.options?.instanceName).toBe('ENV2');
    expect(config.options?.encrypt).toBe(false);
  });

  it('should work without instanceName (backward compatibility)', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb');

    expect(config.options?.instanceName).toBeUndefined();
    expect(config.server).toBe('localhost');
    expect(config.port).toBe(1433);
  });
});

describe('DSN Parser - SQL Server SSL/TLS Configuration', () => {
  it('should parse sslmode=disable correctly', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/db?sslmode=disable');

    expect(config.options?.encrypt).toBe(false);
    expect(config.options?.trustServerCertificate).toBe(false);
  });

  it('should parse sslmode=require correctly', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/db?sslmode=require');

    expect(config.options?.encrypt).toBe(true);
    expect(config.options?.trustServerCertificate).toBe(true);
  });

  it('should default to unencrypted when no sslmode specified', async () => {
    const parser = new SQLServerConnector().dsnParser;
    const config = await parser.parse('sqlserver://user:pass@localhost:1433/db');

    expect(config.options?.encrypt).toBe(false);
    expect(config.options?.trustServerCertificate).toBe(false);
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

describe('OracleConnector.splitStatements', () => {
  const split = OracleConnector.splitStatements;

  it('splits plain SQL on top-level semicolons and drops the terminators', () => {
    expect(split("INSERT INTO t VALUES (1); SELECT * FROM t;")).toEqual([
      'INSERT INTO t VALUES (1)',
      'SELECT * FROM t',
    ]);
  });

  it('keeps an anonymous block whole, semicolons included', () => {
    const block = 'BEGIN\n  UPDATE t SET x = 1;\n  DELETE FROM u;\nEND;';
    expect(split(block)).toEqual([block]);
  });

  it('keeps a PL/SQL block whole inside a mixed batch', () => {
    const block = 'BEGIN\n  UPDATE t SET x = 1;\nEND;';
    expect(split(`INSERT INTO t VALUES (1);\n${block}\nSELECT * FROM t`)).toEqual([
      'INSERT INTO t VALUES (1)',
      block,
      'SELECT * FROM t',
    ]);
  });

  it('handles DECLARE sections, nested blocks, IF/LOOP/CASE and exception handlers', () => {
    const block = [
      'DECLARE',
      '  n NUMBER := 0;',
      'BEGIN',
      '  FOR r IN (SELECT CASE WHEN x > 1 THEN 1 ELSE 0 END AS c FROM t) LOOP',
      '    IF r.c = 1 THEN n := n + 1; END IF;',
      '    CASE n WHEN 1 THEN NULL; ELSE NULL; END CASE;',
      '  END LOOP;',
      '  BEGIN',
      '    NULL;',
      '  EXCEPTION WHEN OTHERS THEN NULL;',
      '  END;',
      'END;',
    ].join('\n');
    expect(split(`${block}\nSELECT 1 FROM dual`)).toEqual([block, 'SELECT 1 FROM dual']);
  });

  it('keeps two routine definitions apart', () => {
    const fn = 'CREATE OR REPLACE FUNCTION f RETURN NUMBER IS\nBEGIN\n  RETURN 1;\nEND;';
    const proc = 'CREATE OR REPLACE PROCEDURE p(x OUT NUMBER) IS\nBEGIN\n  x := 1;\nEND;';
    expect(split(`${fn}\n/\n${proc}\n/`)).toEqual([fn, proc]);
    expect(split(`${fn}\n${proc}`)).toEqual([fn, proc]);
  });

  it('treats a package spec as one unit even though it has no BEGIN', () => {
    const pkg = 'CREATE PACKAGE pk IS\n  PROCEDURE a;\n  FUNCTION b RETURN NUMBER;\nEND pk;';
    expect(split(`${pkg}\nSELECT 1 FROM dual`)).toEqual([pkg, 'SELECT 1 FROM dual']);
  });

  it('ignores keywords and semicolons inside strings and comments', () => {
    const sql = "SELECT q'[begin; end;]' AS s, 'end' AS e FROM dual; -- begin\nSELECT 2 FROM dual";
    // A comment between statements is boundary noise, not part of the next statement.
    expect(split(sql)).toEqual([
      "SELECT q'[begin; end;]' AS s, 'end' AS e FROM dual",
      'SELECT 2 FROM dual',
    ]);
  });

  it('drops SQL*Plus slash terminator lines', () => {
    expect(split('SELECT 1 FROM dual;\n/\n')).toEqual(['SELECT 1 FROM dual']);
    expect(split('BEGIN NULL; END;\n/')).toEqual(['BEGIN NULL; END;']);
  });

  it('honours a slash line as the boundary of plain SQL with no semicolon', () => {
    expect(split('SELECT 1 FROM dual\n/\nSELECT 2 FROM dual')).toEqual([
      'SELECT 1 FROM dual',
      'SELECT 2 FROM dual',
    ]);
  });

  it('ignores empty statements from consecutive separators', () => {
    expect(split('SELECT 1 FROM dual;; SELECT 2 FROM dual;\n;\n')).toEqual([
      'SELECT 1 FROM dual',
      'SELECT 2 FROM dual',
    ]);
  });

  it('keeps a compound trigger whole through its section terminators', () => {
    const trigger = [
      'CREATE OR REPLACE TRIGGER audit_t',
      '  FOR INSERT OR UPDATE ON t',
      '  COMPOUND TRIGGER',
      '  n NUMBER := 0;',
      '  BEFORE STATEMENT IS',
      '  BEGIN',
      '    n := 0;',
      '  END BEFORE STATEMENT;',
      '  AFTER EACH ROW IS',
      '  BEGIN',
      '    n := n + 1;',
      '  END AFTER EACH ROW;',
      '  AFTER STATEMENT IS',
      '  BEGIN',
      '    NULL;',
      '  END AFTER STATEMENT;',
      'END audit_t;',
    ].join('\n');
    expect(split(`${trigger}\nSELECT 1 FROM dual`)).toEqual([trigger, 'SELECT 1 FROM dual']);
  });
});

describe('OracleConnector.bindsFor', () => {
  it('names each :N placeholder after parameters[N-1], once, in any order', () => {
    expect(OracleConnector.bindsFor('SELECT :2 AS a, :1 AS b, :1 AS c FROM dual', ['one', 'two'])).toEqual({
      '1': 'one',
      '2': 'two',
    });
  });

  it('includes only the placeholders the statement uses', () => {
    expect(OracleConnector.bindsFor('SELECT :2 FROM dual', ['one', 'two', 'three'])).toEqual({ '2': 'two' });
    expect(OracleConnector.bindsFor('SELECT 1 FROM dual', ['one'])).toEqual({});
  });

  it('ignores :N inside literals, comments and PostgreSQL-style casts', () => {
    expect(OracleConnector.bindsFor("SELECT q'[:1]' AS s, ':2' AS t, x::1 FROM dual -- :3", ['a', 'b', 'c'])).toEqual({});
  });
});

describe('OracleConnector.convertNumber', () => {
  it('returns safe integers as numbers, larger integers as BigInt, decimals as numbers', () => {
    expect(OracleConnector.convertNumber('42')).toBe(42);
    expect(OracleConnector.convertNumber('-7')).toBe(-7);
    expect(OracleConnector.convertNumber('9007199254740991')).toBe(9007199254740991);
    expect(OracleConnector.convertNumber('9007199254740993')).toBe(9007199254740993n);
    expect(OracleConnector.convertNumber('-12345678901234567890')).toBe(-12345678901234567890n);
    expect(OracleConnector.convertNumber('1.5')).toBe(1.5);
    expect(OracleConnector.convertNumber('1E+125')).toBe(1e125);
    expect(OracleConnector.convertNumber(null)).toBeNull();
  });
});
