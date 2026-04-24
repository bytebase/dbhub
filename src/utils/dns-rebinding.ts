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
export function validateOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined
): OriginValidation {
  if (!originHeader) return { ok: true };

  let originHostname: string;
  try {
    originHostname = new URL(originHeader).hostname.toLowerCase();
  } catch {
    return { ok: false, status: 400, message: 'Malformed Origin header' };
  }

  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader ?? ''}`).hostname.toLowerCase();
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
