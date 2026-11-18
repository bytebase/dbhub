import { describe, it, expect } from 'vitest';
import { validateAuthToken } from '../auth-token.js';

describe('validateAuthToken', () => {
  it.each<[string, string | undefined, string[]]>([
    ['any request when no tokens are configured', undefined, []],
    ['any header when no tokens are configured', 'Bearer whatever', []],
    ['a matching bearer token', 'Bearer secret123', ['secret123']],
    ['a token that matches any entry in a multi-token list', 'Bearer second-token', ['first-token', 'second-token', 'third-token']],
  ])('allows %s', (_label, header, tokens) => {
    expect(validateAuthToken(header, tokens)).toEqual({ ok: true });
  });

  const malformed = 'Missing or malformed Authorization header. Expected: Bearer <token>';
  const invalid = 'Invalid bearer token';

  it.each<[string, string | undefined, string]>([
    ['a missing Authorization header', undefined, malformed],
    ['a header without the Bearer scheme', 'secret123', malformed],
    ['a wrong scheme such as Basic auth', 'Basic dXNlcjpwYXNz', malformed],
    ['an incorrect token', 'Bearer wrong-token', invalid],
    ['an empty bearer token', 'Bearer ', invalid],
    ['a token differing only in length from a configured one', 'Bearer secret1234extra', invalid],
    ['a token differing only in case (comparison is case sensitive)', 'Bearer SECRET123', invalid],
  ])('rejects %s', (_label, header, message) => {
    expect(validateAuthToken(header, ['secret123'])).toEqual({ ok: false, status: 401, message });
  });
});
