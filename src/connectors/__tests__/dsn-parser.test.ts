import { describe, it, expect } from 'vitest';
import { MySQLConnector } from '../mysql/index.js';
import { MariaDBConnector } from '../mariadb/index.js';
import { SQLServerConnector } from '../sqlserver/index.js';

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
