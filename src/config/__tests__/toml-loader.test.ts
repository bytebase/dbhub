import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadTomlConfig, buildDSNFromSource } from '../toml-loader.js';
import type { SourceConfig } from '../../types/config.js';
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
    // Clear command line arguments
    process.argv = ['node', 'test'];
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
  });

  describe('loadTomlConfig', () => {
    it('should load valid TOML config from dbhub.toml', () => {
      const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

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

    it('should parse DSN and populate connection fields for postgres', () => {
      const tomlContent = `
[[sources]]
id = "pg_dsn"
dsn = "postgres://pguser:secret@db.example.com:5433/mydb"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result?.sources[0]).toMatchObject({
        id: 'pg_dsn',
        type: 'postgres',
        host: 'db.example.com',
        port: 5433,
        database: 'mydb',
        user: 'pguser',
      });
    });

    it('should parse DSN and populate connection fields for mysql', () => {
      const tomlContent = `
[[sources]]
id = "mysql_dsn"
dsn = "mysql://root:password@mysql.local:3307/appdb"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result?.sources[0]).toMatchObject({
        id: 'mysql_dsn',
        type: 'mysql',
        host: 'mysql.local',
        port: 3307,
        database: 'appdb',
        user: 'root',
      });
    });

    it('should parse DSN and populate connection fields for sqlite', () => {
      const tomlContent = `
[[sources]]
id = "sqlite_dsn"
dsn = "sqlite:///path/to/database.db"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

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

    it('should not override explicit connection params with DSN values', () => {
      const tomlContent = `
[[sources]]
id = "explicit_override"
dsn = "postgres://dsn_user:pass@dsn_host:5432/dsn_db"
type = "postgres"
host = "explicit_host"
port = 9999
database = "explicit_db"
user = "explicit_user"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      // Explicit values should be preserved, not overwritten by DSN
      expect(result?.sources[0]).toMatchObject({
        id: 'explicit_override',
        type: 'postgres',
        host: 'explicit_host',
        port: 9999,
        database: 'explicit_db',
        user: 'explicit_user',
      });
    });

    it('should load config from custom path with --config flag', () => {
      const customConfigPath = path.join(tempDir, 'custom.toml');
      const tomlContent = `
[[sources]]
id = "custom_db"
dsn = "mysql://user:pass@localhost:3306/db"
`;
      fs.writeFileSync(customConfigPath, tomlContent);
      process.argv = ['node', 'test', '--config', customConfigPath];

      const result = loadTomlConfig();

      expect(result).toBeTruthy();
      expect(result?.sources[0].id).toBe('custom_db');
      expect(result?.source).toBe('custom.toml');
    });

    it('should return null when no config file exists', () => {
      const result = loadTomlConfig();
      expect(result).toBeNull();
    });

    it('should load multiple sources', () => {
      const tomlContent = `
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
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result?.sources).toHaveLength(3);
      expect(result?.sources[0].id).toBe('db1');
      expect(result?.sources[1].id).toBe('db2');
      expect(result?.sources[2].id).toBe('db3');
    });

    it('should expand tilde in ssh_key paths', () => {
      const tomlContent = `
[[sources]]
id = "remote_db"
dsn = "postgres://user:pass@10.0.0.5:5432/db"
ssh_host = "bastion.example.com"
ssh_user = "ubuntu"
ssh_key = "~/.ssh/id_rsa"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result?.sources[0].ssh_key).toBe(
        path.join(os.homedir(), '.ssh', 'id_rsa')
      );
    });

    it('should expand tilde in sqlite database paths', () => {
      const tomlContent = `
[[sources]]
id = "local_db"
type = "sqlite"
database = "~/databases/test.db"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result?.sources[0].database).toBe(
        path.join(os.homedir(), 'databases', 'test.db')
      );
    });

    it('should throw error for missing sources array', () => {
      const tomlContent = `
[server]
port = 8080
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow(
        'must contain a [[sources]] array'
      );
    });

    it('should throw error for empty sources array', () => {
      const tomlContent = `sources = []`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow('sources array cannot be empty');
    });

    it('should throw error for duplicate source IDs', () => {
      const tomlContent = `
[[sources]]
id = "duplicate"
dsn = "postgres://user:pass@localhost:5432/db1"

[[sources]]
id = "duplicate"
dsn = "mysql://user:pass@localhost:3306/db2"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow('duplicate source IDs found: duplicate');
    });

    it('should throw error for source without id', () => {
      const tomlContent = `
[[sources]]
dsn = "postgres://user:pass@localhost:5432/db"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow("each source must have an 'id' field");
    });

    it('should throw error for source without DSN or connection params', () => {
      const tomlContent = `
[[sources]]
id = "invalid"
readonly = true
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow('must have either');
    });

    it('should throw error for invalid database type', () => {
      const tomlContent = `
[[sources]]
id = "invalid"
type = "oracle"
host = "localhost"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow("invalid type 'oracle'");
    });

    it('should throw error for invalid max_rows', () => {
      const tomlContent = `
[[sources]]
id = "test"
dsn = "postgres://user:pass@localhost:5432/db"

[[tools]]
name = "execute_sql"
source = "test"
max_rows = -100
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow('invalid max_rows');
    });

    it('should throw error for invalid ssh_port', () => {
      const tomlContent = `
[[sources]]
id = "test"
dsn = "postgres://user:pass@localhost:5432/db"
ssh_host = "bastion.example.com"
ssh_user = "ubuntu"
ssh_key = "~/.ssh/id_rsa"
ssh_port = 99999
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow('invalid ssh_port');
    });

    it('should throw error for non-existent config file specified by --config', () => {
      process.argv = ['node', 'test', '--config', '/nonexistent/path/config.toml'];

      expect(() => loadTomlConfig()).toThrow('Configuration file specified by --config flag not found');
    });

    describe('connection_timeout validation', () => {
      it('should accept valid connection_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
connection_timeout = 60
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].connection_timeout).toBe(60);
      });

      it('should throw error for negative connection_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
connection_timeout = -30
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow('invalid connection_timeout');
      });

      it('should throw error for zero connection_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
connection_timeout = 0
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow('invalid connection_timeout');
      });

      it('should accept large connection_timeout values', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
connection_timeout = 300
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].connection_timeout).toBe(300);
      });

      it('should work without connection_timeout (optional field)', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].connection_timeout).toBeUndefined();
      });
    });

    describe('description field', () => {
      it('should parse description field', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
description = "Production read replica for analytics"
dsn = "postgres://user:pass@localhost:5432/testdb"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].description).toBe('Production read replica for analytics');
      });

      it('should work without description (optional field)', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].description).toBeUndefined();
      });
    });

    describe('sslmode validation', () => {
      it('should accept sslmode = "disable"', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "postgres"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
sslmode = "disable"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].sslmode).toBe('disable');
      });

      it('should accept sslmode = "require"', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "postgres"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
sslmode = "require"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].sslmode).toBe('require');
      });

      it('should throw error for invalid sslmode value', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "postgres"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
sslmode = "invalid"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow("invalid sslmode 'invalid'");
      });

      it('should throw error when sslmode is specified for SQLite', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "sqlite"
database = "/path/to/database.db"
sslmode = "require"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow("SQLite does not support SSL");
      });

      it('should work without sslmode (optional field)', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].sslmode).toBeUndefined();
      });
    });

    describe('SQL Server authentication validation', () => {
      it('should accept authentication = "ntlm" with domain', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "sqlserver"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
authentication = "ntlm"
domain = "MYDOMAIN"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].authentication).toBe('ntlm');
        expect(result?.sources[0].domain).toBe('MYDOMAIN');
      });

      it('should accept authentication = "azure-active-directory-access-token" without password', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "sqlserver"
host = "myserver.database.windows.net"
database = "testdb"
user = "admin@tenant.onmicrosoft.com"
authentication = "azure-active-directory-access-token"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].authentication).toBe('azure-active-directory-access-token');
        expect(result?.sources[0].password).toBeUndefined();
      });

      it('should throw error for invalid authentication value', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "sqlserver"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
authentication = "invalid"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow("invalid authentication 'invalid'");
      });

      it('should throw error when authentication is used with non-SQL Server database', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "postgres"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
authentication = "ntlm"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow("only supported for SQL Server");
      });

      it('should throw error when NTLM authentication is missing domain', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "sqlserver"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
authentication = "ntlm"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow("'domain' is not specified");
      });

      it('should throw error when domain is used without authentication', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "sqlserver"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
domain = "MYDOMAIN"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow("authentication is not set");
      });

      it('should throw error when domain is used with non-ntlm authentication', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "sqlserver"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
authentication = "azure-active-directory-access-token"
domain = "MYDOMAIN"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow("Domain is only valid with authentication = \"ntlm\"");
      });

      it('should throw error when domain is used with non-SQL Server database', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
type = "postgres"
host = "localhost"
database = "testdb"
user = "user"
password = "pass"
domain = "MYDOMAIN"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow("domain but it is only supported for SQL Server");
      });

      it('should throw error when authentication is used with non-SQL Server DSN (no explicit type)', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
authentication = "ntlm"
domain = "MYDOMAIN"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow("only supported for SQL Server");
      });

      it('should accept authentication with SQL Server DSN (no explicit type)', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "sqlserver://user:pass@localhost:1433/testdb"
authentication = "ntlm"
domain = "MYDOMAIN"
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].authentication).toBe('ntlm');
        expect(result?.sources[0].domain).toBe('MYDOMAIN');
      });
    });

    describe('query_timeout validation', () => {
      it('should accept valid query_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
query_timeout = 120
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].query_timeout).toBe(120);
      });

      it('should throw error for negative query_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
query_timeout = -60
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow('invalid query_timeout');
      });

      it('should throw error for zero query_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
query_timeout = 0
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow('invalid query_timeout');
      });

      it('should accept both connection_timeout and query_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
connection_timeout = 30
query_timeout = 120
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].connection_timeout).toBe(30);
        expect(result?.sources[0].query_timeout).toBe(120);
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

    it('should build PostgreSQL DSN from individual params', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'testuser',
        password: 'testpass',
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('postgres://testuser:testpass@localhost:5432/testdb');
    });

    it('should build MySQL DSN with default port', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'mysql',
        host: 'localhost',
        database: 'testdb',
        user: 'root',
        password: 'secret',
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('mysql://root:secret@localhost:3306/testdb');
    });

    it('should build MariaDB DSN with default port', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'mariadb',
        host: 'localhost',
        database: 'testdb',
        user: 'root',
        password: 'secret',
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('mariadb://root:secret@localhost:3306/testdb');
    });

    it('should build SQL Server DSN with default port', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'sqlserver',
        host: 'localhost',
        database: 'master',
        user: 'sa',
        password: 'StrongPass123',
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('sqlserver://sa:StrongPass123@localhost:1433/master');
    });

    it('should build SQL Server DSN with instanceName', () => {
      const source: SourceConfig = {
        id: 'sqlserver_instance',
        type: 'sqlserver',
        host: 'localhost',
        port: 1433,
        database: 'testdb',
        user: 'sa',
        password: 'Pass123!',
        instanceName: 'ENV1'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('sqlserver://sa:Pass123!@localhost:1433/testdb?instanceName=ENV1');
    });

    it('should build PostgreSQL DSN with sslmode', () => {
      const source: SourceConfig = {
        id: 'pg_ssl',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'user',
        password: 'pass',
        sslmode: 'require'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('postgres://user:pass@localhost:5432/testdb?sslmode=require');
    });

    it('should build MySQL DSN with sslmode', () => {
      const source: SourceConfig = {
        id: 'mysql_ssl',
        type: 'mysql',
        host: 'localhost',
        database: 'testdb',
        user: 'root',
        password: 'secret',
        sslmode: 'disable'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('mysql://root:secret@localhost:3306/testdb?sslmode=disable');
    });

    it('should build SQL Server DSN with both instanceName and sslmode', () => {
      const source: SourceConfig = {
        id: 'sqlserver_full',
        type: 'sqlserver',
        host: 'localhost',
        port: 1433,
        database: 'testdb',
        user: 'sa',
        password: 'Pass123!',
        instanceName: 'SQLEXPRESS',
        sslmode: 'require'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('sqlserver://sa:Pass123!@localhost:1433/testdb?instanceName=SQLEXPRESS&sslmode=require');
    });

    it('should build SQL Server DSN with NTLM authentication', () => {
      const source: SourceConfig = {
        id: 'sqlserver_ntlm',
        type: 'sqlserver',
        host: 'sqlserver.corp.local',
        port: 1433,
        database: 'appdb',
        user: 'jsmith',
        password: 'secret',
        authentication: 'ntlm',
        domain: 'CORP'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('sqlserver://jsmith:secret@sqlserver.corp.local:1433/appdb?authentication=ntlm&domain=CORP');
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

      expect(dsn).toBe('sqlite:////path/to/database.db');
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

    it('should allow missing password for Azure AD access token auth', () => {
      const source: SourceConfig = {
        id: 'test',
        type: 'sqlserver',
        host: 'server.database.windows.net',
        database: 'mydb',
        user: 'admin@tenant.onmicrosoft.com',
        authentication: 'azure-active-directory-access-token',
        // No password - allowed for Azure AD
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toContain('sqlserver://');
      expect(dsn).toContain(':@'); // empty password
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
      const tomlContent = `
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
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

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

      // Verify third source (SQLite)
      expect(result?.sources[2]).toMatchObject({
        id: 'local_sqlite',
        type: 'sqlite',
      });
      expect(result?.sources[2].database).toBe(
        path.join(os.homedir(), 'databases', 'local.db')
      );
    });

    it('should handle config with all database types', () => {
      const tomlContent = `
[[sources]]
id = "pg"
type = "postgres"
host = "localhost"
database = "pgdb"
user = "pguser"
password = "pgpass"

[[sources]]
id = "my"
type = "mysql"
host = "localhost"
database = "mydb"
user = "myuser"
password = "mypass"

[[sources]]
id = "maria"
type = "mariadb"
host = "localhost"
database = "mariadb"
user = "mariauser"
password = "mariapass"

[[sources]]
id = "mssql"
type = "sqlserver"
host = "localhost"
database = "master"
user = "sa"
password = "sqlpass"

[[sources]]
id = "sqlite"
type = "sqlite"
database = ":memory:"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result?.sources).toHaveLength(5);
      expect(result?.sources.map(s => s.id)).toEqual(['pg', 'my', 'maria', 'mssql', 'sqlite']);
    });
  });

  describe('Custom Tool Configuration', () => {
    it('should accept custom tool with readonly and max_rows', () => {
      const tomlContent = `
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
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

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

    it('should accept custom tool with readonly only', () => {
      const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "list_departments"
source = "test_db"
description = "List all departments"
statement = "SELECT * FROM departments"
readonly = true
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result?.tools).toHaveLength(1);
      expect(result?.tools![0]).toMatchObject({
        name: 'list_departments',
        readonly: true,
      });
      expect(result?.tools![0].max_rows).toBeUndefined();
    });

    it('should accept custom tool with max_rows only', () => {
      const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "search_logs"
source = "test_db"
description = "Search application logs"
statement = "SELECT * FROM logs WHERE level = 'ERROR'"
max_rows = 500
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result?.tools).toHaveLength(1);
      expect(result?.tools![0]).toMatchObject({
        name: 'search_logs',
        max_rows: 500,
      });
      expect(result?.tools![0].readonly).toBeUndefined();
    });

    it('should accept custom tool without readonly or max_rows', () => {
      const tomlContent = `
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
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result?.tools).toHaveLength(1);
      expect(result?.tools![0]).toMatchObject({
        name: 'update_status',
        description: 'Update user status',
      });
      expect(result?.tools![0].readonly).toBeUndefined();
      expect(result?.tools![0].max_rows).toBeUndefined();
    });

    it('should throw error for custom tool with invalid readonly type', () => {
      const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "test_tool"
source = "test_db"
description = "Test tool"
statement = "SELECT 1"
readonly = "yes"
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow('invalid readonly');
    });

    it('should throw error for custom tool with invalid max_rows', () => {
      const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "test_tool"
source = "test_db"
description = "Test tool"
statement = "SELECT 1"
max_rows = -50
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow('invalid max_rows');
    });

    it('should throw error for custom tool with zero max_rows', () => {
      const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"

[[tools]]
name = "test_tool"
source = "test_db"
description = "Test tool"
statement = "SELECT 1"
max_rows = 0
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      expect(() => loadTomlConfig()).toThrow('invalid max_rows');
    });
  });
});
