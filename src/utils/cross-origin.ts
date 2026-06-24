import os from "node:os";

/**
 * Result of validating an HTTP request's Host (and Origin) headers against
 * the configured allow-list.
 */
export type OriginValidation =
  | { ok: true }
  | { ok: false; status: 400 | 403; message: string };

/**
 * DNS-rebinding defense for the HTTP transport.
 *
 * The previous implementation only checked that the request's `Origin`
 * hostname equalled its `Host` hostname. That is self-consistency between two
 * attacker-controlled values, not a trust decision: after DNS rebinding a
 * malicious page issues requests where *both* headers carry the attacker's
 * hostname, so the equality check passes and the browser reaches `/mcp`
 * (GHSA-fm8p-53ww-hf6w, GHSA-fp99-xwp4-hv8q, GHSA-qvg2-3c48-77mx).
 *
 * The real fix is to validate the `Host` header against an explicit allow-list
 * of hostnames the operator actually serves on — loopback by default. A
 * rebound `Host: evil.attacker.test` is not on that list and is rejected
 * regardless of what `Origin` says. The check runs even when `Origin` is
 * absent, because a rebound *same-origin* POST (the page and `/mcp` share the
 * attacker hostname) may omit `Origin` entirely.
 *
 * WHATWG URL parsing is used for both headers so IPv6 bracket notation
 * (e.g. `[::1]:8080`) is handled correctly — a naive `split(':')[0]` on the
 * Host header yields `"["` for IPv6 literals.
 */

// Characters that must not appear in a Host header per RFC 3986's host/port
// grammar.  `new URL("http://" + host)` is lax — `evil.com/foo` silently
// parses to hostname `evil.com` with path `/foo`, and `evil.com@localhost`
// parses to hostname `localhost` with `evil.com` treated as userinfo.
// Either case would let a crafted Host header slip past the allow-list.
const INVALID_HOST_CHARS = /[\s/\\@?#]/;

// Loopback hostnames are always allowed: this is the default, safe-by-design
// access path for a developer-workstation MCP server. `[::1]` is bracketed to
// match the canonical form `new URL().hostname` produces for IPv6 literals.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// Sentinel entry that disables Host/Origin validation entirely. For operators
// who deliberately expose DBHub on a network behind their own auth/proxy and
// accept the risk.
export const ALLOW_ANY_HOST = "*";

/**
 * Normalize a host entry (from config or a bind address) to the canonical,
 * lower-cased, port-stripped hostname that `new URL().hostname` yields, so it
 * can be compared against parsed request headers. IPv6 literals must be
 * bracketed (e.g. `[::1]`). Returns `null` for empty/unparseable input, or the
 * `ALLOW_ANY_HOST` sentinel passed straight through.
 */
function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === ALLOW_ANY_HOST) return ALLOW_ANY_HOST;
  // Mirror the Host-header validation: reject crafted authority strings such as
  // "evil.com/foo" or "evil.com@localhost" that URL parsing would otherwise
  // silently normalize to an unintended hostname (e.g. an operator typo
  // broadening the allow-list).
  if (INVALID_HOST_CHARS.test(trimmed)) return null;
  try {
    const hostname = new URL(`http://${trimmed}`).hostname.toLowerCase();
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Collect the machine's own hostname and external (non-loopback) interface IP
 * addresses. Used to auto-allow clients that reach DBHub by IP or machine name
 * when bound to a wildcard address, so the common network-access case works
 * without `--allowed-hosts`.
 *
 * This is safe against DNS rebinding: a rebound request carries the *attacker's*
 * hostname in `Host` (the name in the browser's URL bar), never the victim
 * machine's own IP or name, so these entries can never match an attack. A
 * direct cross-origin fetch to one of these IPs still carries a foreign
 * `Origin` and is rejected by the Origin check.
 */
export function getSelfHosts(): string[] {
  const hosts: string[] = [];

  try {
    const hostname = os.hostname().trim();
    if (hostname) hosts.push(hostname);
  } catch {
    // hostname unavailable — skip
  }

  let interfaces: ReturnType<typeof os.networkInterfaces> = {};
  try {
    interfaces = os.networkInterfaces();
  } catch {
    // interface enumeration unavailable — skip
  }

  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      // Loopback is already on the list; skip internal addresses.
      if (!addr.address || addr.internal) continue;

      // Node reports family as the string "IPv6" (or the number 6 on newer
      // releases); handle both.
      const isIPv6 = addr.family === "IPv6" || (addr.family as unknown) === 6;
      if (isIPv6) {
        const bare = addr.address.split("%")[0]; // drop zone id, e.g. fe80::1%en0
        // Link-local addresses need a zone id to be routable and just add
        // noise to the allow-list — skip them.
        if (bare.toLowerCase().startsWith("fe80")) continue;
        hosts.push(`[${bare}]`);
      } else {
        hosts.push(addr.address);
      }
    }
  }

  return hosts;
}

/**
 * Build the set of hostnames the HTTP transport will accept in the `Host`
 * header. Always includes loopback. When bound to a concrete (non-wildcard)
 * address, that address is added. When bound to a wildcard (0.0.0.0 / ::), the
 * machine's own hostname/IPs (`selfHosts`) are added so network clients work
 * without extra config. Operator-configured hosts are always added. A single
 * `*` entry anywhere disables the check (returns a set containing only `*`).
 */
export function buildAllowedHosts(
  configured: string[] = [],
  bindHost?: string,
  selfHosts: string[] = []
): Set<string> {
  const normalizedConfigured = configured
    .map(normalizeHost)
    .filter((h): h is string => h !== null);

  if (normalizedConfigured.includes(ALLOW_ANY_HOST)) {
    return new Set([ALLOW_ANY_HOST]);
  }

  const hosts = new Set<string>();
  for (const h of LOOPBACK_HOSTS) {
    const normalized = normalizeHost(h);
    if (normalized) hosts.add(normalized);
  }

  const normalizedBind = bindHost ? normalizeHost(bindHost) : null;
  // Wildcard binds (0.0.0.0 / ::) are not real hostnames a client targets.
  const bindIsWildcard =
    !normalizedBind || normalizedBind === "0.0.0.0" || normalizedBind === "[::]";

  if (normalizedBind && !bindIsWildcard) {
    hosts.add(normalizedBind);
  }

  // Self hostnames/IPs are only reachable — and thus only relevant — when bound
  // to a wildcard address; a concrete bind already contributed its one address.
  if (bindIsWildcard) {
    for (const h of selfHosts) {
      const normalized = normalizeHost(h);
      if (normalized) hosts.add(normalized);
    }
  }

  for (const h of normalizedConfigured) hosts.add(h);

  return hosts;
}

/**
 * Validate a request's `Host` (and `Origin`, when present) against the
 * allow-list. The `Host` check is the DNS-rebinding defense and always runs;
 * the `Origin` check additionally guards the CORS reflection so an arbitrary
 * origin is never echoed back into `Access-Control-Allow-Origin`.
 */
export function validateOrigin(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  allowedHosts: Set<string>
): OriginValidation {
  const allowAny = allowedHosts.has(ALLOW_ANY_HOST);

  // 1. Validate the Host header (the rebinding defense — runs unconditionally).
  const trimmedHost = (hostHeader ?? "").trim();
  if (!trimmedHost || INVALID_HOST_CHARS.test(trimmedHost)) {
    return { ok: false, status: 400, message: "Malformed Host header" };
  }

  let hostname: string;
  try {
    hostname = new URL(`http://${trimmedHost}`).hostname.toLowerCase();
  } catch {
    return { ok: false, status: 400, message: "Malformed Host header" };
  }
  if (!hostname) {
    return { ok: false, status: 400, message: "Malformed Host header" };
  }

  if (!allowAny && !allowedHosts.has(hostname)) {
    return {
      ok: false,
      status: 403,
      message:
        `Host '${hostname}' is not allowed. Only loopback is permitted by default; ` +
        `set --allowed-hosts (or DBHUB_ALLOWED_HOSTS) to serve other hostnames. ` +
        `This protects against DNS rebinding.`,
    };
  }

  // 2. Origin is only sent by browsers on cross-origin fetches; non-browser
  //    MCP clients omit it. When present it must also be an allowed host so we
  //    never reflect an untrusted origin in the CORS response.
  if (originHeader === undefined) return { ok: true };

  const trimmedOrigin = originHeader.trim();
  if (!trimmedOrigin) {
    return { ok: false, status: 400, message: "Malformed Origin header" };
  }

  let originHostname: string;
  try {
    originHostname = new URL(trimmedOrigin).hostname.toLowerCase();
  } catch {
    return { ok: false, status: 400, message: "Malformed Origin header" };
  }
  if (!originHostname) {
    return { ok: false, status: 400, message: "Malformed Origin header" };
  }

  if (!allowAny && !allowedHosts.has(originHostname)) {
    return {
      ok: false,
      status: 403,
      message: `Origin '${originHostname}' is not allowed`,
    };
  }

  return { ok: true };
}
