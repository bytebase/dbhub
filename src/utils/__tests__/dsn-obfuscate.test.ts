import { describe, it, expect } from 'vitest';
import {
  obfuscateDSNPassword,
  obfuscateSSHConfig,
  getDatabaseTypeFromDSN,
  parseConnectionInfoFromDSN,
} from '../dsn-obfuscate.js';
import type { SSHTunnelConfig } from '../../types/ssh.js';

describe('DSN Obfuscation Utilities', () => {
  describe('obfuscateDSNPassword', () => {
    it('should obfuscate password in postgres DSN', () => {
      const dsn = 'postgres://user:secretpass@localhost:5432/db';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe('postgres://user:********@localhost:5432/db');
    });

    it('should handle DSN without password', () => {
      const dsn = 'postgres://user@localhost:5432/db';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe(dsn);
    });

    it('should not obfuscate SQLite DSN', () => {
      const dsn = 'sqlite:///path/to/database.db';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe(dsn);
    });

    it('should handle empty DSN', () => {
      const result = obfuscateDSNPassword('');
      expect(result).toBe('');
    });
  });

  describe('obfuscateSSHConfig', () => {
    it('should obfuscate password and passphrase', () => {
      const config: SSHTunnelConfig = {
        host: 'bastion.example.com',
        port: 22,
        username: 'ubuntu',
        password: 'secretpassword',
        passphrase: 'keypassphrase',
      };
      const result = obfuscateSSHConfig(config);
      expect(result.password).toBe('********');
      expect(result.passphrase).toBe('********');
      expect(result.host).toBe('bastion.example.com');
      expect(result.username).toBe('ubuntu');
    });
  });

  describe('getDatabaseTypeFromDSN', () => {
    it('should return postgres for postgres:// DSN', () => {
      expect(getDatabaseTypeFromDSN('postgres://user:pass@localhost:5432/db')).toBe('postgres');
    });

    it('should return postgres for postgresql:// DSN', () => {
      expect(getDatabaseTypeFromDSN('postgresql://user:pass@localhost:5432/db')).toBe('postgres');
    });

    it('should return mysql for mysql:// DSN', () => {
      expect(getDatabaseTypeFromDSN('mysql://user:pass@localhost:3306/db')).toBe('mysql');
    });

    it('should return mariadb for mariadb:// DSN', () => {
      expect(getDatabaseTypeFromDSN('mariadb://user:pass@localhost:3306/db')).toBe('mariadb');
    });

    it('should return sqlserver for sqlserver:// DSN', () => {
      expect(getDatabaseTypeFromDSN('sqlserver://user:pass@localhost:1433/db')).toBe('sqlserver');
    });

    it('should return sqlite for sqlite:// DSN', () => {
      expect(getDatabaseTypeFromDSN('sqlite:///path/to/db.db')).toBe('sqlite');
    });

    it('should return undefined for unknown protocol', () => {
      expect(getDatabaseTypeFromDSN('oracle://user:pass@localhost:1521/db')).toBeUndefined();
    });

    it('should return undefined for empty DSN', () => {
      expect(getDatabaseTypeFromDSN('')).toBeUndefined();
    });
  });

  describe('parseConnectionInfoFromDSN', () => {
    it('should parse postgres DSN correctly', () => {
      const dsn = 'postgres://pguser:secret@db.example.com:5433/mydb';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'postgres',
        host: 'db.example.com',
        port: 5433,
        database: 'mydb',
        user: 'pguser',
      });
    });

    it('should parse postgresql:// DSN correctly', () => {
      const dsn = 'postgresql://user:pass@localhost:5432/testdb';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'user',
      });
    });

    it('should parse mysql DSN correctly', () => {
      const dsn = 'mysql://root:password@mysql.local:3307/appdb';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'mysql',
        host: 'mysql.local',
        port: 3307,
        database: 'appdb',
        user: 'root',
      });
    });

    it('should parse mariadb DSN correctly', () => {
      const dsn = 'mariadb://admin:pass123@maria.server:3306/production';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'mariadb',
        host: 'maria.server',
        port: 3306,
        database: 'production',
        user: 'admin',
      });
    });

    it('should parse sqlserver DSN correctly', () => {
      const dsn = 'sqlserver://sa:StrongPass@sqlserver.local:1433/master';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'sqlserver',
        host: 'sqlserver.local',
        port: 1433,
        database: 'master',
        user: 'sa',
      });
    });

    it('should parse sqlite DSN with file path', () => {
      const dsn = 'sqlite:///path/to/database.db';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'sqlite',
        database: '/path/to/database.db',
      });
    });

    it('should parse sqlite DSN with memory database', () => {
      const dsn = 'sqlite:///:memory:';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'sqlite',
        database: ':memory:',
      });
    });

    it('should handle DSN without port', () => {
      const dsn = 'postgres://user:pass@localhost/db';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'postgres',
        host: 'localhost',
        database: 'db',
        user: 'user',
      });
    });

    it('should handle DSN with special characters in password (URL encoded)', () => {
      const dsn = 'postgres://user:p%40ss%23word@localhost:5432/db';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'db',
        user: 'user',
      });
    });

    it('should handle DSN with query parameters', () => {
      const dsn = 'postgres://user:pass@localhost:5432/db?sslmode=require';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'db',
        user: 'user',
      });
    });

    it('should return null for empty DSN', () => {
      expect(parseConnectionInfoFromDSN('')).toBeNull();
    });

    it('should return null for invalid DSN', () => {
      expect(parseConnectionInfoFromDSN('not-a-valid-dsn')).toBeNull();
    });

    it('should handle DSN without user credentials', () => {
      const dsn = 'postgres://localhost:5432/db';
      const result = parseConnectionInfoFromDSN(dsn);

      expect(result).toEqual({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'db',
      });
    });
  });
});
