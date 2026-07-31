import { timingSafeEqual } from "node:crypto";

/**
 * Result of validating an HTTP request's `Authorization` header against the
 * configured bearer token allow-list.
 */
export type AuthTokenValidation =
  | { ok: true }
  | { ok: false; status: 401; message: string };

const BEARER_PREFIX = "Bearer ";

/**
 * Constant-time string equality. `timingSafeEqual` throws on unequal-length
 * buffers, so unequal lengths are rejected up front — this leaks only the
 * length of the configured token, not which bytes matched, which is the same
 * trade-off `timingSafeEqual` itself makes.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Bearer token auth for the HTTP transport (issue #66): "anyone with the
 * server URL can access the database." An empty `tokens` list means auth is
 * disabled — configuring a token is itself the opt-in (see
 * `resolveAuthTokens()` in `src/config/env.ts`), so there is no separate
 * "--require-auth" flag to forget to set.
 *
 * This intentionally stops at a shared-secret allow-list rather than
 * implementing the MCP spec's full OAuth 2.1 resource-server model (RFC 9728
 * protected-resource metadata, authorization-server discovery, dynamic client
 * registration, PKCE). That machinery solves multi-tenant identity
 * federation; DBHub's actual gap is coarser — "is this request from someone
 * who has the secret," not "who is this user and what scopes do they have."
 */
export function validateAuthToken(
  authorizationHeader: string | undefined,
  tokens: string[]
): AuthTokenValidation {
  if (tokens.length === 0) return { ok: true };

  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    return {
      ok: false,
      status: 401,
      message: "Missing or malformed Authorization header. Expected: Bearer <token>",
    };
  }

  const presented = authorizationHeader.slice(BEARER_PREFIX.length);
  const matches = tokens.some((token) => constantTimeEqual(presented, token));
  if (!matches) {
    return { ok: false, status: 401, message: "Invalid bearer token" };
  }

  return { ok: true };
}
