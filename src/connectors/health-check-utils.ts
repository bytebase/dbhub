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
 * yet (zero or non-finite logical reads). Clamped to [0, 100]: the two
 * counters are read via separate, non-atomic queries, so physicalReads can
 * momentarily exceed logicalReads under concurrent load and would otherwise
 * produce a nonsensical negative (or >100) ratio.
 */
export function computeHitRatioPct(logicalReads: number, physicalReads: number): number | null {
  if (!Number.isFinite(logicalReads) || !Number.isFinite(physicalReads) || logicalReads === 0) {
    return null;
  }
  const pct = Math.round(((logicalReads - physicalReads) / logicalReads) * 10000) / 100;
  return Math.min(100, Math.max(0, pct));
}
