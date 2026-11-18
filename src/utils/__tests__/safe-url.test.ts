import { describe, it, expect } from 'vitest';
import { SafeURL, rawQueryParamValues, replaceDSNHostPort } from '../safe-url.js';

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

  it.each([
    ['postgres://user:pass@[::1]:5432/dbname', '::1', '5432'],
    ['mysql://[2001:db8::1]:3306/dbname', '2001:db8::1', '3306'],
    ['postgres://[::1]/dbname', '::1', ''],
  ])('should parse a bracketed IPv6 host in %s', (dsn, hostname, port) => {
    const url = new SafeURL(dsn);
    expect(url.hostname).toBe(hostname);
    expect(url.port).toBe(port);
    expect(url.pathname).toBe('/dbname');
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

  it('should keep a query value that itself contains "="', () => {
    const url = new SafeURL('oracle://localhost:1522/svc?ssl_server_cert_dn=CN=db,O=Acme&wallet_password=abc==&flag');

    expect(url.getSearchParam('ssl_server_cert_dn')).toBe('CN=db,O=Acme');
    expect(url.getSearchParam('wallet_password')).toBe('abc==');
    expect(url.getSearchParam('flag')).toBeNull();
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

describe('replaceDSNHostPort', () => {
  it.each([
    ['host and port', 'postgres://user:pass@db.internal:5432/mydb', 'postgres://user:pass@127.0.0.1:55000/mydb'],
    ['host without a port', 'postgres://user:pass@db.internal/mydb', 'postgres://user:pass@127.0.0.1:55000/mydb'],
    ['no credentials', 'mysql://db.internal:3306/mydb', 'mysql://127.0.0.1:55000/mydb'],
    ['no path', 'mysql://user:pass@db.internal:3306', 'mysql://user:pass@127.0.0.1:55000'],
    ['query without a path', 'mysql://user:pass@db.internal?sslmode=require', 'mysql://user:pass@127.0.0.1:55000?sslmode=require'],
    ['bracketed IPv6 host', 'postgres://user:pass@[2001:db8::1]:5432/mydb', 'postgres://user:pass@127.0.0.1:55000/mydb'],
    ['an @ in the password', 'postgres://user:p@ss@db.internal:5432/mydb', 'postgres://user:p@ss@127.0.0.1:55000/mydb'],
    ['an @ in the path', 'sqlserver://user:pass@db.internal/we@ird', 'sqlserver://user:pass@127.0.0.1:55000/we@ird'],
    ['an @ and / in the query', 'postgres://db.internal/mydb?sslrootcert=/a@b/ca.pem', 'postgres://127.0.0.1:55000/mydb?sslrootcert=/a@b/ca.pem'],
  ])('replaces %s', (_, dsn, expected) => {
    expect(replaceDSNHostPort(dsn, '127.0.0.1', 55000)).toBe(expected);
  });

  it('leaves credentials and query exactly as written', () => {
    // Raw and percent-encoded characters both survive: nothing is decoded or
    // re-encoded, so the connector parses the same DSN the user wrote.
    const dsn = 'postgres://us%40er:pa#ss%2Fword@db.internal:5432/mydb?options=-c%20search_path%3Dapp';

    const rewritten = replaceDSNHostPort(dsn, '127.0.0.1', 55000);

    expect(rewritten).toBe('postgres://us%40er:pa#ss%2Fword@127.0.0.1:55000/mydb?options=-c%20search_path%3Dapp');
    expect(new SafeURL(rewritten).password).toBe(new SafeURL(dsn).password);
  });

  it('brackets an IPv6 replacement host', () => {
    expect(replaceDSNHostPort('postgres://user:pass@db.internal:5432/mydb', '::1', 55000)).toBe(
      'postgres://user:pass@[::1]:55000/mydb'
    );
  });

  it('rejects a string without a protocol', () => {
    expect(() => replaceDSNHostPort('user:pass@db.internal/mydb', '127.0.0.1', 55000)).toThrow(
      'missing protocol'
    );
  });
});

describe('rawQueryParamValues', () => {
  const dsn = (query: string) => `postgres://user:pass@localhost:5432/db${query}`;

  it.each([
    ['no query string', '', []],
    ['the parameter absent', '?application_name=app', []],
    ['one value', '?sslmode=require', ['require']],
    ['an empty value', '?sslmode=', ['']],
    ['a bare parameter', '?sslmode', ['']],
    ['a repeated parameter, in order', '?sslmode=disable&a=b&sslmode=require', ['disable', 'require']],
    ['an empty value among valid ones', '?sslmode=require&sslmode=', ['require', '']],
  ])('returns the values for %s', (_, query, expected) => {
    expect(rawQueryParamValues(dsn(query), 'sslmode')).toEqual(expected);
  });

  it('sees what SafeURL drops', () => {
    // The reason this helper exists: to SafeURL an empty sslmode is no sslmode
    const empty = dsn('?sslmode=');
    expect(new SafeURL(empty).getSearchParam('sslmode')).toBeNull();
    expect(rawQueryParamValues(empty, 'sslmode')).toEqual(['']);
  });

  it('decodes values', () => {
    expect(rawQueryParamValues(dsn('?sslrootcert=%2Fetc%2Fca.pem'), 'sslrootcert')).toEqual(['/etc/ca.pem']);
  });
});
