import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality. `timingSafeEqual` throws on unequal-length
 * buffers, so unequal lengths are rejected up front — this leaks only the
 * length of the compared values, not which bytes matched, which is the same
 * trade-off `timingSafeEqual` itself makes.
 *
 * Shared by the bearer-token allow-list (`auth-token.ts`) and SSH host key
 * verification (`ssh-host-key.ts`) so both security checks use one vetted
 * primitive.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
