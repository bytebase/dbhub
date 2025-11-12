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
readonly = false
max_rows = 1000
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result).toBeTruthy();
      expect(result?.sources).toHaveLength(1);
      expect(result?.sources[0]).toEqual({
        id: 'test_db',
        dsn: 'postgres://user:pass@localhost:5432/testdb',
        readonly: false,
        max_rows: 1000,
      });
      expect(result?.source).toBe('dbhub.toml');
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
        // Missing user, password, database
      };

      expect(() => buildDSNFromSource(source)).toThrow(
        'missing required connection parameters'
      );
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
readonly = true
max_rows = 1000
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
max_rows = 500

[[sources]]
id = "local_sqlite"
type = "sqlite"
database = "~/databases/local.db"
readonly = false
`;
      fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

      const result = loadTomlConfig();

      expect(result).toBeTruthy();
      expect(result?.sources).toHaveLength(3);

      // Verify first source (with SSH)
      expect(result?.sources[0]).toMatchObject({
        id: 'prod_pg',
        dsn: 'postgres://user:pass@10.0.0.5:5432/production',
        readonly: true,
        max_rows: 1000,
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
        max_rows: 500,
      });

      // Verify third source (SQLite)
      expect(result?.sources[2]).toMatchObject({
        id: 'local_sqlite',
        type: 'sqlite',
        readonly: false,
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
});
