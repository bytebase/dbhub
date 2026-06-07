/**
 * Result of validating an HTTP request's Origin against its Host header.
 */
export type OriginValidation =
  | { ok: true }
  | { ok: false; status: 400 | 403; message: string };

/**
 * Check that a request's Origin hostname equals its Host header hostname.
 *
 * Scope and limitations:
 *
 * - This is a cross-origin-fetch guard, not a full DNS-rebinding defense.
 *   A true rebinding attacker controls both the DNS record the browser
 *   resolves *and* the Origin the script sends, so they can trivially
 *   arrange for `Origin` and `Host` to agree while still pointing at a
 *   local service. A proper defense requires validating `Host` against
 *   an allowlist and/or requiring authentication — tracked as future
 *   hardening for the HTTP transport.
 * - What this *does* block is the simpler case of a browser on a
 *   different origin (e.g., an attacker's public site) making an
 *   authenticated cross-origin fetch: browsers always attach the real
 *   Origin on such requests, and it will not match the local Host.
 * - Browsers always send `Origin` on cross-origin fetches; non-browser
 *   MCP clients typically omit it, so a missing `Origin` is allowed
 *   through.
 *
 * WHATWG URL parsing is used for both headers so IPv6 bracket notation
 * (e.g., `[::1]:8080`) is handled correctly — a naive `split(':')[0]` on
 * the Host header yields `"["` for IPv6 literals, which breaks the match.
 */
// Characters that must not appear in a Host header per RFC 3986's host/port
// grammar.  `new URL("http://" + host)` is lax — `evil.com/foo` silently
// parses to hostname `evil.com` with path `/foo`, and `evil.com@localhost`
// parses to hostname `localhost` with `evil.com` treated as userinfo.
// Either case would let a crafted Host header slip past the equality match.
const INVALID_HOST_CHARS = /[\s/\\@?#]/;

export function validateOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined
): OriginValidation {
  // A genuinely absent Origin is allowed: non-browser MCP clients routinely
  // omit it, and the whole check is only meaningful for browser cross-origin
  // fetches.  An explicitly present but empty (or whitespace-only) Origin
  // is not what a browser would ever send, so treat it as malformed rather
  // than silently bypassing the guard.
  if (originHeader === undefined) return { ok: true };

  const trimmedOrigin = originHeader.trim();
  if (!trimmedOrigin) {
    return { ok: false, status: 400, message: 'Malformed Origin header' };
  }

  const trimmedHost = (hostHeader ?? '').trim();
  if (!trimmedHost || INVALID_HOST_CHARS.test(trimmedHost)) {
    return { ok: false, status: 400, message: 'Malformed Host header' };
  }

  let originHostname: string;
  try {
    originHostname = new URL(trimmedOrigin).hostname.toLowerCase();
  } catch {
    return { ok: false, status: 400, message: 'Malformed Origin header' };
  }

  let hostname: string;
  try {
    hostname = new URL(`http://${trimmedHost}`).hostname.toLowerCase();
  } catch {
    return { ok: false, status: 400, message: 'Malformed Host header' };
  }

  if (!hostname) {
    return { ok: false, status: 400, message: 'Malformed Host header' };
  }

  if (originHostname !== hostname) {
    return {
      ok: false,
      status: 403,
      message: 'Origin does not match Host header',
    };
  }

  return { ok: true };
}
