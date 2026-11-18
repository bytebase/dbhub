import { describe, it, expect } from 'vitest';
import { SafeURL, rawQueryParamValues, replaceDSNHostPort } from '../safe-url.js';

describe('SafeURL', () => {
  // What each row leaves out: the protocol of most DSNs below, and parts a DSN
  // does not have, which parse as the empty string.
  const defaults = { protocol: 'postgres:', hostname: '', port: '', pathname: '', username: '', password: '' };

  it.each([
    ['a simple DSN', 'postgres://localhost:5432/dbname', { hostname: 'localhost', port: '5432', pathname: '/dbname' }],
    [
      'a DSN with authentication',
      'postgres://user:password@localhost:5432/dbname',
      { hostname: 'localhost', port: '5432', pathname: '/dbname', username: 'user', password: 'password' },
    ],
    ['a DSN without a pathname', 'postgres://localhost:5432', { hostname: 'localhost', port: '5432' }],
    [
      'a bracketed IPv6 host with credentials',
      'postgres://user:pass@[::1]:5432/dbname',
      { hostname: '::1', port: '5432', pathname: '/dbname', username: 'user', password: 'pass' },
    ],
    ['a bracketed IPv6 host', 'mysql://[2001:db8::1]:3306/dbname', { protocol: 'mysql:', hostname: '2001:db8::1', port: '3306', pathname: '/dbname' }],
    ['a bracketed IPv6 host without a port', 'postgres://[::1]/dbname', { hostname: '::1', pathname: '/dbname' }],
    [
      'a percent-encoded special character in the password',
      'postgres://user:pass%23word@localhost:5432/dbname',
      { hostname: 'localhost', port: '5432', pathname: '/dbname', username: 'user', password: 'pass#word' },
    ],
    [
      'an unencoded special character in the password',
      'postgres://user:pass#word@localhost:5432/dbname',
      { hostname: 'localhost', port: '5432', pathname: '/dbname', username: 'user', password: 'pass#word' },
    ],
    [
      'special characters in both username and password',
      'postgres://user%40domain:pass%26word@localhost:5432/dbname',
      { hostname: 'localhost', port: '5432', pathname: '/dbname', username: 'user@domain', password: 'pass&word' },
    ],
    // The authority is split on its last '@', not the first. Splitting on the
    // first yields a truncated password and hostname 'ss@localhost', so the
    // failure surfaces as a DNS lookup error rather than as a bad password — a
    // confusing way to learn it was truncated.
    [
      "an '@' inside the password",
      'sqlserver://user:pa@ss@localhost:1433/dbname',
      { protocol: 'sqlserver:', hostname: 'localhost', port: '1433', pathname: '/dbname', username: 'user', password: 'pa@ss' },
    ],
    [
      "several '@' inside the password",
      'sqlserver://user:a@b@c@localhost:1433/dbname',
      { protocol: 'sqlserver:', hostname: 'localhost', port: '1433', pathname: '/dbname', username: 'user', password: 'a@b@c' },
    ],
    // The path is still attached when the authority is split, so an unbounded
    // lastIndexOf would pick the '@' in the database name instead.
    [
      "an '@' in the path as well as the authority",
      'sqlserver://user:pass@localhost/we@ird',
      { protocol: 'sqlserver:', hostname: 'localhost', pathname: '/we@ird', username: 'user', password: 'pass' },
    ],
    ["an '@' in the path only", 'sqlserver://localhost/we@ird', { protocol: 'sqlserver:', hostname: 'localhost', pathname: '/we@ird' }],
  ])('should parse %s', (_label, dsn, parts) => {
    const { searchParams, ...parsed } = new SafeURL(dsn);
    expect(parsed).toEqual({ ...defaults, ...parts });
    expect(searchParams.size).toBe(0);
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

  it('should support the forEachSearchParam method', () => {
    const url = new SafeURL('postgres://localhost:5432/dbname?param1=value1&param2=value2');
    const params: Record<string, string> = {};
    
    url.forEachSearchParam((value, key) => {
      params[key] = value;
    });
    
    expect(params).toEqual({ param1: 'value1', param2: 'value2' });
  });

  it('should throw an error for empty URLs', () => {
    expect(() => new SafeURL('')).toThrow('URL string cannot be empty');
  });
  
  it('should throw an error for URLs without a protocol', () => {
    expect(() => new SafeURL('localhost:5432/dbname')).toThrow('Invalid URL format: missing protocol');
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
