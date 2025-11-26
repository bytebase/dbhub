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

    it('should preserve query parameters when obfuscating', () => {
      const dsn = 'postgres://user:secretpass@localhost:5432/db?sslmode=require';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe('postgres://user:********@localhost:5432/db?sslmode=require');
    });

    it('should preserve multiple query parameters when obfuscating', () => {
      const dsn = 'postgres://user:pass@localhost:5432/db?sslmode=require&connect_timeout=10';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe('postgres://user:****@localhost:5432/db?sslmode=require&connect_timeout=10');
    });

    it('should obfuscate DSN without database path', () => {
      const dsn = 'postgres://user:pass@localhost:5432';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe('postgres://user:****@localhost:5432');
    });

    it('should obfuscate DSN without username but with password', () => {
      const dsn = 'postgres://:pass@localhost:5432/db';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe('postgres://****@localhost:5432/db');
    });

    it('should obfuscate DSN without username and without database path', () => {
      const dsn = 'postgres://:pass@localhost:5432';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe('postgres://****@localhost:5432');
    });

    it('should obfuscate DSN without database path but with query parameters', () => {
      const dsn = 'postgres://user:pass@localhost:5432?sslmode=require';
      const result = obfuscateDSNPassword(dsn);
      expect(result).toBe('postgres://user:****@localhost:5432?sslmode=require');
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
    it.each([
      ['postgres://user:pass@localhost:5432/db', 'postgres'],
      ['postgresql://user:pass@localhost:5432/db', 'postgres'],
      ['mysql://user:pass@localhost:3306/db', 'mysql'],
      ['mariadb://user:pass@localhost:3306/db', 'mariadb'],
      ['sqlserver://user:pass@localhost:1433/db', 'sqlserver'],
      ['sqlite:///path/to/db.db', 'sqlite'],
    ])('should return correct type for %s', (dsn, expected) => {
      expect(getDatabaseTypeFromDSN(dsn)).toBe(expected);
    });

    it.each([
      ['oracle://user:pass@localhost:1521/db', 'unknown protocol'],
      ['', 'empty DSN'],
    ])('should return undefined for %s', (dsn) => {
      expect(getDatabaseTypeFromDSN(dsn)).toBeUndefined();
    });
  });

  describe('parseConnectionInfoFromDSN', () => {
    // Test standard database DSNs
    it.each([
      ['postgres://pguser:secret@db.example.com:5433/mydb', { type: 'postgres', host: 'db.example.com', port: 5433, database: 'mydb', user: 'pguser' }],
      ['postgresql://user:pass@localhost:5432/testdb', { type: 'postgres', host: 'localhost', port: 5432, database: 'testdb', user: 'user' }],
      ['mysql://root:password@mysql.local:3307/appdb', { type: 'mysql', host: 'mysql.local', port: 3307, database: 'appdb', user: 'root' }],
      ['mariadb://admin:pass123@maria.server:3306/production', { type: 'mariadb', host: 'maria.server', port: 3306, database: 'production', user: 'admin' }],
      ['sqlserver://sa:StrongPass@sqlserver.local:1433/master', { type: 'sqlserver', host: 'sqlserver.local', port: 1433, database: 'master', user: 'sa' }],
    ])('should parse %s correctly', (dsn, expected) => {
      expect(parseConnectionInfoFromDSN(dsn)).toEqual(expected);
    });

    // Test SQLite path variations
    it.each([
      ['sqlite:///path/to/database.db', '/path/to/database.db', 'Unix absolute'],
      ['sqlite:///:memory:', ':memory:', 'memory'],
      ['sqlite:///./relative/path.db', './relative/path.db', 'relative with ./'],
      ['sqlite:///~/databases/local.db', '~/databases/local.db', 'home directory'],
      ['sqlite:///C:/Users/test/database.db', 'C:/Users/test/database.db', 'Windows absolute'],
    ])('should parse sqlite DSN with %s path', (dsn, expectedDb) => {
      expect(parseConnectionInfoFromDSN(dsn)).toEqual({ type: 'sqlite', database: expectedDb });
    });

    // Test edge cases
    it('should handle DSN without port', () => {
      expect(parseConnectionInfoFromDSN('postgres://user:pass@localhost/db')).toEqual({
        type: 'postgres', host: 'localhost', database: 'db', user: 'user',
      });
    });

    it('should handle DSN with query parameters', () => {
      expect(parseConnectionInfoFromDSN('postgres://user:pass@localhost:5432/db?sslmode=require')).toEqual({
        type: 'postgres', host: 'localhost', port: 5432, database: 'db', user: 'user',
      });
    });

    it('should handle DSN without user credentials', () => {
      expect(parseConnectionInfoFromDSN('postgres://localhost:5432/db')).toEqual({
        type: 'postgres', host: 'localhost', port: 5432, database: 'db',
      });
    });

    it.each([
      ['', 'empty'],
      ['not-a-valid-dsn', 'invalid'],
    ])('should return null for %s DSN', (dsn) => {
      expect(parseConnectionInfoFromDSN(dsn)).toBeNull();
    });
  });
});
