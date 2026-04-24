/**
 * Result of validating an HTTP request's Origin against its Host header.
 */
export type OriginValidation =
  | { ok: true }
  | { ok: false; status: 400 | 403; message: string };

/**
 * Check that a request's Origin hostname matches its Host header hostname.
 *
 * Browsers always send Origin on cross-origin fetches (the DNS-rebinding
 * threat model), while non-browser MCP clients typically omit it. A missing
 * Origin is therefore allowed through — the check is a defense against
 * browser-originated cross-origin requests only.
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
      message: 'Origin does not match Host header (DNS rebinding protection)',
    };
  }

  return { ok: true };
}
