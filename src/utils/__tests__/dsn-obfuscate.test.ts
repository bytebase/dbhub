import { describe, it, expect } from 'vitest';
import {
  obfuscateDSNPassword,
  REDACTED_DSN,
  obfuscateSSHConfig,
  getDatabaseTypeFromDSN,
  parseConnectionInfoFromDSN,
} from '../dsn-obfuscate.js';
import type { SSHTunnelConfig } from '../../types/ssh.js';

describe('DSN Obfuscation Utilities', () => {
  describe('obfuscateDSNPassword', () => {
    it.each([
      ['postgres://user:secretpass@localhost:5432/db', 'postgres://user:********@localhost:5432/db'],
      // Nothing to mask: no password, SQLite path, empty string
      ['postgres://user@localhost:5432/db', 'postgres://user@localhost:5432/db'],
      ['sqlite:///path/to/database.db', 'sqlite:///path/to/database.db'],
      ['', ''],
      // Query parameters and a missing database path are preserved
      ['postgres://user:secretpass@localhost:5432/db?sslmode=require', 'postgres://user:********@localhost:5432/db?sslmode=require'],
      ['postgres://user:pass@localhost:5432/db?sslmode=require&connect_timeout=10', 'postgres://user:****@localhost:5432/db?sslmode=require&connect_timeout=10'],
      ['postgres://user:pass@localhost:5432', 'postgres://user:****@localhost:5432'],
      ['postgres://user:pass@localhost:5432?sslmode=require', 'postgres://user:****@localhost:5432?sslmode=require'],
      // Password without a username
      ['postgres://:pass@localhost:5432/db', 'postgres://****@localhost:5432/db'],
      ['postgres://:pass@localhost:5432', 'postgres://****@localhost:5432'],
      // The whole password is masked when it contains '@' or '#': splitting the
      // authority on the first '@' would leave the tail of the password in the
      // string, which DBHub prints per source at startup.
      ['postgres://user:pa@ss@localhost:5432/db', 'postgres://user:*****@localhost:5432/db'],
      ['postgres://user:pa#ss@localhost:5432/db', 'postgres://user:*****@localhost:5432/db'],
    ])('should obfuscate %s as %s', (dsn, expected) => {
      expect(obfuscateDSNPassword(dsn)).toBe(expected);
    });

    it('should fail closed on a scheme-less DSN instead of echoing it', () => {
      // SafeURL rejects input without "://", so nothing can be parsed out of
      // it — but it may still carry a password, so the original must not
      // be returned.
      const dsn = 'user:hunter2@localhost/db';
      const result = obfuscateDSNPassword(dsn);

      expect(result).toBe(REDACTED_DSN);
      expect(result).not.toContain('hunter2');
    });

    it('should fail closed when the authority has no @ and a credential lands in the port', () => {
      // "user:secret" without a host parses as host "user", port "secret",
      // so there is no password field to mask — the whole string must be
      // withheld instead.
      for (const dsn of ['postgres://user:secret/db', 'postgres://user:secret?sslmode=require']) {
        const result = obfuscateDSNPassword(dsn);

        expect(result).toBe(REDACTED_DSN);
        expect(result).not.toContain('secret');
      }
    });

    it('should still obfuscate a DSN with an unknown scheme', () => {
      const dsn = 'db2://user:hunter2@localhost:50000/db';
      const result = obfuscateDSNPassword(dsn);

      expect(result).toBe('db2://user:*******@localhost:50000/db');
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

    it('should keep the private key path as-is', () => {
      const config: SSHTunnelConfig = { host: 'bastion.example.com', username: 'ubuntu', privateKey: '/home/user/.ssh/id_rsa' };
      expect(obfuscateSSHConfig(config).privateKey).toBe('/home/user/.ssh/id_rsa');
    });
  });

  describe('getDatabaseTypeFromDSN', () => {
    it.each([
      ['postgres://user:pass@localhost:5432/db', 'postgres'],
      ['postgresql://user:pass@localhost:5432/db', 'postgres'],
      ['mysql://user:pass@localhost:3306/db', 'mysql'],
      ['mariadb://user:pass@localhost:3306/db', 'mariadb'],
      ['sqlserver://user:pass@localhost:1433/db', 'sqlserver'],
      ['oracle://user:pass@localhost:1521/FREEPDB1', 'oracle'],
      ['sqlite:///path/to/db.db', 'sqlite'],
    ])('should return correct type for %s', (dsn, expected) => {
      expect(getDatabaseTypeFromDSN(dsn)).toBe(expected);
    });

    it.each([
      ['db2://user:pass@localhost:50000/db', 'unknown protocol'],
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
      ['oracle://app:secret@ora.local:1521/FREEPDB1', { type: 'oracle', host: 'ora.local', port: 1521, database: 'FREEPDB1', user: 'app' }],
      // Edge cases: no port, query parameters, no user credentials
      ['postgres://user:pass@localhost/db', { type: 'postgres', host: 'localhost', database: 'db', user: 'user' }],
      ['postgres://user:pass@localhost:5432/db?sslmode=require', { type: 'postgres', host: 'localhost', port: 5432, database: 'db', user: 'user' }],
      ['postgres://localhost:5432/db', { type: 'postgres', host: 'localhost', port: 5432, database: 'db' }],
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

    it.each([
      ['', 'empty'],
      ['not-a-valid-dsn', 'invalid'],
    ])('should return null for %s DSN', (dsn) => {
      expect(parseConnectionInfoFromDSN(dsn)).toBeNull();
    });
  });
});
