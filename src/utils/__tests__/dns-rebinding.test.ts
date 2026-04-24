import { describe, it, expect } from 'vitest';
import { validateOrigin } from '../dns-rebinding.js';

describe('validateOrigin', () => {
  it('allows requests with no Origin header (non-browser clients)', () => {
    expect(validateOrigin(undefined, 'localhost:8080')).toEqual({ ok: true });
  });

  it('allows matching origin and host (hostname)', () => {
    expect(validateOrigin('http://localhost:5173', 'localhost:8080')).toEqual({ ok: true });
  });

  it('allows matching origin and host (IPv4)', () => {
    expect(validateOrigin('http://127.0.0.1:5173', '127.0.0.1:8080')).toEqual({ ok: true });
  });

  it('allows matching origin and host for IPv6 bracketed literals', () => {
    // Regression: .split(":")[0] mangled [::1]:8080 to "["; URL parsing preserves ::1.
    expect(validateOrigin('http://[::1]:5173', '[::1]:8080')).toEqual({ ok: true });
  });

  it('allows matching origin and host for full IPv6 addresses', () => {
    expect(
      validateOrigin('http://[fe80::1]:5173', '[fe80::1]:8080')
    ).toEqual({ ok: true });
  });

  it('is case-insensitive on hostnames', () => {
    expect(validateOrigin('http://LocalHost:5173', 'localhost:8080')).toEqual({ ok: true });
  });

  it('rejects when Origin host does not match Host header', () => {
    const result = validateOrigin('http://evil.com', 'localhost:8080');
    expect(result).toEqual({
      ok: false,
      status: 403,
      message: 'Origin does not match Host header',
    });
  });

  it('rejects when Origin is malformed with status 400', () => {
    const result = validateOrigin('not a url', 'localhost:8080');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe('Malformed Origin header');
    }
  });

  it('rejects when Host header is malformed with status 400', () => {
    const result = validateOrigin('http://localhost:5173', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe('Malformed Host header');
    }
  });

  it('rejects when IPv4 origin does not match IPv6 host', () => {
    const result = validateOrigin('http://127.0.0.1:5173', '[::1]:8080');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});
