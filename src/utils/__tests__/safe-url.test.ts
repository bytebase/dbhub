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

  it.each([
    ['percent-encoded', 'postgres://user:pass%23word@localhost:5432/dbname'],
    ['unencoded', 'postgres://user:pass#word@localhost:5432/dbname'],
  ])('should handle a %s special character in the password', (_form, dsn) => {
    expect(new SafeURL(dsn).password).toBe('pass#word');
  });

  it('should parse query parameters correctly', () => {
    const url = new SafeURL('postgres://localhost:5432/dbname?sslmode=require&timeout=30');
    
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
    it.each([
      ['pa@ss', 'sqlserver://user:pa@ss@localhost:1433/dbname'],
      ['a@b@c', 'sqlserver://user:a@b@c@localhost:1433/dbname'],
    ])('splits on the last @ of the authority, not the first (password %j)', (password, dsn) => {
      // Splitting on the first '@' yields a truncated password and hostname
      // 'ss@localhost', so the failure surfaces as a DNS lookup error rather
      // than as a bad password — a confusing way to learn it was truncated.
      const url = new SafeURL(dsn);

      expect(url.username).toBe('user');
      expect(url.password).toBe(password);
      expect(url.hostname).toBe('localhost');
      expect(url.port).toBe('1433');
      expect(url.pathname).toBe('/dbname');
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
  });
});