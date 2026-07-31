import { describe, it, expect } from 'vitest';
import { validateAuthToken } from '../auth-token.js';

describe('validateAuthToken', () => {
  it('allows any request when no tokens are configured', () => {
    expect(validateAuthToken(undefined, [])).toEqual({ ok: true });
    expect(validateAuthToken('Bearer whatever', [])).toEqual({ ok: true });
  });

  it('accepts a matching bearer token', () => {
    const result = validateAuthToken('Bearer secret123', ['secret123']);
    expect(result).toEqual({ ok: true });
  });

  it('accepts a token that matches any entry in a multi-token list', () => {
    const tokens = ['first-token', 'second-token', 'third-token'];
    expect(validateAuthToken('Bearer second-token', tokens)).toEqual({ ok: true });
  });

  it('rejects a missing Authorization header', () => {
    const result = validateAuthToken(undefined, ['secret123']);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401 });
  });

  it('rejects a header without the Bearer scheme', () => {
    const result = validateAuthToken('secret123', ['secret123']);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401 });
  });

  it('rejects a wrong scheme such as Basic auth', () => {
    const result = validateAuthToken('Basic dXNlcjpwYXNz', ['secret123']);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401 });
  });

  it('rejects an incorrect token', () => {
    const result = validateAuthToken('Bearer wrong-token', ['secret123']);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401 });
  });

  it('rejects an empty bearer token', () => {
    const result = validateAuthToken('Bearer ', ['secret123']);
    expect(result.ok).toBe(false);
  });

  it('rejects a token differing only in length from a configured one', () => {
    const result = validateAuthToken('Bearer secret1234extra', ['secret123']);
    expect(result.ok).toBe(false);
  });

  it('is case sensitive on token comparison', () => {
    const result = validateAuthToken('Bearer SECRET123', ['secret123']);
    expect(result.ok).toBe(false);
  });
});
