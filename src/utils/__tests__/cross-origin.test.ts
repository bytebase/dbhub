import { describe, it, expect } from 'vitest';
import { validateOrigin, buildAllowedHosts, getSelfHosts, ALLOW_ANY_HOST } from '../cross-origin.js';

// Default allow-list for a loopback deployment (no operator-configured hosts,
// wildcard bind which contributes nothing).
const loopback = buildAllowedHosts([], '0.0.0.0');

describe('buildAllowedHosts', () => {
  it('always includes loopback hostnames', () => {
    const hosts = buildAllowedHosts([], '0.0.0.0');
    expect(hosts.has('localhost')).toBe(true);
    expect(hosts.has('127.0.0.1')).toBe(true);
    expect(hosts.has('[::1]')).toBe(true);
  });

  it('does not add wildcard bind addresses as hostnames', () => {
    expect(buildAllowedHosts([], '0.0.0.0').has('0.0.0.0')).toBe(false);
    expect(buildAllowedHosts([], '::').has('[::]')).toBe(false);
  });

  it('adds a concrete bind host', () => {
    expect(buildAllowedHosts([], '192.168.1.10').has('192.168.1.10')).toBe(true);
  });

  it('adds operator-configured hosts, ignoring ports and case', () => {
    const hosts = buildAllowedHosts(['Example.com:8443', 'db.internal'], '127.0.0.1');
    expect(hosts.has('example.com')).toBe(true);
    expect(hosts.has('db.internal')).toBe(true);
  });

  it('drops crafted configured entries instead of normalizing them to a hostname', () => {
    // "evil.com/foo" and "evil.com@host" would URL-parse to a hostname; reject
    // them so an operator typo cannot silently broaden the allow-list.
    const hosts = buildAllowedHosts(['evil.com/foo', 'evil.com@trusted.example'], '127.0.0.1');
    expect(hosts.has('evil.com')).toBe(false);
    expect(hosts.has('trusted.example')).toBe(false);
  });

  it('collapses to the wildcard sentinel when "*" is configured', () => {
    const hosts = buildAllowedHosts(['*', 'example.com'], '127.0.0.1');
    expect(hosts.has(ALLOW_ANY_HOST)).toBe(true);
    expect(hosts.size).toBe(1);
  });

  it('normalizes a bracketed IPv6 configured host', () => {
    expect(buildAllowedHosts(['[fe80::1]'], '127.0.0.1').has('[fe80::1]')).toBe(true);
  });

  it('auto-allows self hosts only when bound to a wildcard address', () => {
    const selfHosts = ['my-laptop', '192.168.1.5', '[2001:db8::1]'];

    // Wildcard bind → self hosts are reachable, so they are allowed.
    const wildcard = buildAllowedHosts([], '0.0.0.0', selfHosts);
    expect(wildcard.has('my-laptop')).toBe(true);
    expect(wildcard.has('192.168.1.5')).toBe(true);
    expect(wildcard.has('[2001:db8::1]')).toBe(true);

    // Concrete bind → only that address is reachable; self hosts are omitted.
    const concrete = buildAllowedHosts([], '127.0.0.1', selfHosts);
    expect(concrete.has('192.168.1.5')).toBe(false);
    expect(concrete.has('my-laptop')).toBe(false);
    expect(concrete.has('127.0.0.1')).toBe(true);
  });

  it('lower-cases and normalizes self host entries', () => {
    const hosts = buildAllowedHosts([], '::', ['My-Host', '10.0.0.2']);
    expect(hosts.has('my-host')).toBe(true);
    expect(hosts.has('10.0.0.2')).toBe(true);
  });
});

describe('getSelfHosts', () => {
  it('does not include loopback or IPv6 link-local addresses', () => {
    const hosts = getSelfHosts();
    expect(hosts).not.toContain('127.0.0.1');
    expect(hosts).not.toContain('::1');
    expect(hosts.some((h) => h.toLowerCase().startsWith('[fe80'))).toBe(false);
  });

  it('produces entries that survive the allow-list and validate against themselves', () => {
    // Whatever this machine reports must round-trip: building an allow-list from
    // it (wildcard bind) and validating that Host returns ok. Capture once —
    // OS interface enumeration can change between calls.
    const selfHosts = getSelfHosts();
    const allowed = buildAllowedHosts([], '0.0.0.0', selfHosts);
    for (const h of selfHosts) {
      expect(validateOrigin(undefined, h, allowed)).toEqual({ ok: true });
    }
  });
});

describe('validateOrigin', () => {
  it.each([
    ['no Origin header', undefined, 'localhost:8080'],
    ['matching hostname', 'http://localhost:5173', 'localhost:8080'],
    ['matching IPv4', 'http://127.0.0.1:5173', '127.0.0.1:8080'],
    // Regression: .split(":")[0] mangled [::1]:8080 to "["; URL parsing preserves ::1.
    ['matching bracketed IPv6 literal', 'http://[::1]:5173', '[::1]:8080'],
    // 127.0.0.1 and ::1 are both loopback, so reflecting one to the other is safe.
    ['cross-loopback pair (both on the allow-list)', 'http://127.0.0.1:5173', '[::1]:8080'],
    ['hostname differing only in case', 'http://LocalHost:5173', 'localhost:8080'],
  ])('allows an allowed host with %s', (_case, origin, host) => {
    expect(validateOrigin(origin, host, loopback)).toEqual({ ok: true });
  });

  it('rejects a rebound attacker host even when Origin matches it (the CVE)', () => {
    // This is the DNS-rebinding shape: Host and Origin agree, but the hostname
    // is not one we serve, so the request must be refused.
    const result = validateOrigin(
      'http://evil.attacker.test',
      'evil.attacker.test:8080',
      loopback
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.message).toContain('not allowed');
    }
  });

  it('rejects a rebound attacker host with no Origin header (same-origin POST)', () => {
    const result = validateOrigin(undefined, 'evil.attacker.test:8080', loopback);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects an off-list Origin even when Host is allowed', () => {
    const result = validateOrigin('http://evil.com', 'localhost:8080', loopback);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.message).toContain("Origin 'evil.com'");
    }
  });

  it('allows an operator-configured deployment host', () => {
    const allowed = buildAllowedHosts(['app.internal'], '0.0.0.0');
    expect(validateOrigin('http://app.internal', 'app.internal:8080', allowed)).toEqual({ ok: true });
  });

  it('allows any host/origin when the wildcard is configured', () => {
    const any = buildAllowedHosts(['*'], '0.0.0.0');
    expect(validateOrigin('http://evil.attacker.test', 'evil.attacker.test', any)).toEqual({ ok: true });
    expect(validateOrigin(undefined, 'anything.example', any)).toEqual({ ok: true });
  });

  // `Origin:` with an empty or blank value is not the same as "Origin absent"; a
  // browser would not produce it, and letting it through bypasses the guard.
  it.each([['not a url'], [''], ['   ']])('rejects a malformed Origin header %j with 400', (origin) => {
    expect(validateOrigin(origin, 'localhost:8080', loopback)).toEqual({
      ok: false,
      status: 400,
      message: 'Malformed Origin header',
    });
  });

  // `new URL("http://evil.com/localhost:8080").hostname` silently yields
  // "evil.com" and `new URL("http://evil.com@localhost:8080").hostname` yields
  // "localhost"; the char filter rejects crafted Hosts before they can match.
  it.each([[''], ['evil.com/localhost:8080'], ['evil.com@localhost:8080'], ['localhost 8080']])(
    'rejects a malformed Host header %j with 400',
    (host) => {
      expect(validateOrigin('http://localhost:8080', host, loopback)).toEqual({
        ok: false,
        status: 400,
        message: 'Malformed Host header',
      });
    }
  );
});
