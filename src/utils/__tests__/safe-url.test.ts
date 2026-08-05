import { describe, it, expect } from 'vitest';
import { SafeURL } from '../safe-url.js';

describe('SafeURL', () => {
  it('should parse a simple DSN correctly', () => {
    const url = new SafeURL('postgres://localhost:5432/dbname');
    
    expect(url.protocol).toBe('postgres:');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/dbname');
    expect(url.username).toBe('');
    expect(url.password).toBe('');
    expect(url.searchParams.size).toBe(0);
  });

  it('should parse a DSN with authentication correctly', () => {
    const url = new SafeURL('postgres://user:password@localhost:5432/dbname');
    
    expect(url.protocol).toBe('postgres:');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/dbname');
    expect(url.username).toBe('user');
    expect(url.password).toBe('password');
    expect(url.searchParams.size).toBe(0);
  });

  it('should handle special characters in password correctly', () => {
    const url = new SafeURL('postgres://user:pass%23word@localhost:5432/dbname');
    
    expect(url.protocol).toBe('postgres:');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/dbname');
    expect(url.username).toBe('user');
    expect(url.password).toBe('pass#word');
    expect(url.searchParams.size).toBe(0);
  });

  it('should handle unencoded special characters in password correctly', () => {
    const url = new SafeURL('postgres://user:pass#word@localhost:5432/dbname');
    
    expect(url.protocol).toBe('postgres:');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/dbname');
    expect(url.username).toBe('user');
    expect(url.password).toBe('pass#word');
    expect(url.searchParams.size).toBe(0);
  });

  it('should parse query parameters correctly', () => {
    const url = new SafeURL('postgres://localhost:5432/dbname?sslmode=require&timeout=30');
    
    expect(url.protocol).toBe('postgres:');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/dbname');
    expect(url.searchParams.size).toBe(2);
    expect(url.getSearchParam('sslmode')).toBe('require');
    expect(url.getSearchParam('timeout')).toBe('30');
  });

  it('should handle special characters in query parameters', () => {
    const url = new SafeURL('postgres://localhost:5432/dbname?param=value%20with%20spaces');
    
    expect(url.getSearchParam('param')).toBe('value with spaces');
  });

  it('should handle a DSN without a pathname', () => {
    const url = new SafeURL('postgres://localhost:5432');
    
    expect(url.protocol).toBe('postgres:');
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('');
  });

  it('should handle both username and password with special characters', () => {
    const url = new SafeURL('postgres://user%40domain:pass%26word@localhost:5432/dbname');
    
    expect(url.username).toBe('user@domain');
    expect(url.password).toBe('pass&word');
  });

  it('should support the forEachSearchParam method', () => {
    const url = new SafeURL('postgres://localhost:5432/dbname?param1=value1&param2=value2');
    const params: Record<string, string> = {};
    
    url.forEachSearchParam((value, key) => {
      params[key] = value;
    });
    
    expect(Object.keys(params).length).toBe(2);
    expect(params['param1']).toBe('value1');
    expect(params['param2']).toBe('value2');
  });

  it('should throw an error for empty URLs', () => {
    expect(() => new SafeURL('')).toThrow('URL string cannot be empty');
  });
  
  it('should throw an error for URLs without a protocol', () => {
    expect(() => new SafeURL('localhost:5432/dbname')).toThrow('Invalid URL format: missing protocol');
  });

  describe("'@' inside the password", () => {
    it('splits on the last @ of the authority, not the first', () => {
      // Splitting on the first '@' yields password 'pa' and hostname
      // 'ss@localhost', so the failure surfaces as a DNS lookup error rather
      // than as a bad password — a confusing way to learn it was truncated.
      const url = new SafeURL('sqlserver://user:pa@ss@localhost/dbname');

      expect(url.username).toBe('user');
      expect(url.password).toBe('pa@ss');
      expect(url.hostname).toBe('localhost');
      expect(url.pathname).toBe('/dbname');
    });

    it('handles a password containing several @ characters', () => {
      const url = new SafeURL('sqlserver://user:a@b@c@host/db');

      expect(url.username).toBe('user');
      expect(url.password).toBe('a@b@c');
      expect(url.hostname).toBe('host');
    });

    it('does not treat an @ in the path as the separator', () => {
      // The path is still attached when the authority is split, so an unbounded
      // lastIndexOf would pick the '@' in the database name instead.
      const url = new SafeURL('sqlserver://user:pass@localhost/we@ird');

      expect(url.username).toBe('user');
      expect(url.password).toBe('pass');
      expect(url.hostname).toBe('localhost');
      expect(url.pathname).toBe('/we@ird');
    });

    it('keeps working when only the path contains an @', () => {
      const url = new SafeURL('sqlserver://localhost/we@ird');

      expect(url.username).toBe('');
      expect(url.password).toBe('');
      expect(url.hostname).toBe('localhost');
      expect(url.pathname).toBe('/we@ird');
    });

    it('still accepts a percent-encoded @', () => {
      const url = new SafeURL('sqlserver://user:pa%40ss@localhost/dbname');

      expect(url.password).toBe('pa@ss');
      expect(url.hostname).toBe('localhost');
    });

    it('keeps the port when the password carries an @', () => {
      const url = new SafeURL('sqlserver://user:pa@ss@localhost:1433/dbname');

      expect(url.password).toBe('pa@ss');
      expect(url.hostname).toBe('localhost');
      expect(url.port).toBe('1433');
    });
  });
});