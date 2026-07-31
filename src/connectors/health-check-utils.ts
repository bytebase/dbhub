/**
 * Shared helpers for connector getHealthCheck() implementations.
 */

/** Converts a possibly-null/undefined driver value to a number, preserving null. */
export function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Computes a cache/buffer hit-ratio percentage (0-100, rounded to 2 decimals)
 * from logical vs physical read counts. Returns null when there's no data
 * yet (zero logical reads).
 */
export function computeHitRatioPct(logicalReads: number, physicalReads: number): number | null {
  if (logicalReads === 0) return null;
  return Math.round(((logicalReads - physicalReads) / logicalReads) * 10000) / 100;
}
