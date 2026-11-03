/**
 * Column-name disambiguation for query result sets.
 *
 * Every driver DBHub ships builds its default row objects by assigning each
 * value into an object keyed by column name. A result with two columns of the
 * same name - `SELECT count(*), count(*) FILTER (...)`, or an unaliased join
 * where both tables have `id` - therefore keeps only the last value and still
 * reports success (bytebase/dbhub#484). The driver's column metadata lists every
 * column, so the data is only lost at that final step.
 *
 * Connectors avoid it by fetching rows positionally (each driver's array row
 * mode) and rebuilding the objects here under unique names: the first column
 * keeps its name and later ones get `_1`, `_2`, ... - the convention
 * node-oracledb applies itself - skipping any suffix that would collide with
 * a name the result already has.
 */

/**
 * Returns `names` with repeated entries renamed so every name is unique.
 *
 * The first occurrence of a name keeps it; each later occurrence becomes
 * `<name>_<n>` for the smallest `n >= 1` that neither appears in the original
 * list nor was already assigned. Original names are never changed, so a
 * column a caller aliased explicitly keeps the name they gave it.
 */
export function uniqueColumnNames(names: readonly string[]): string[] {
  const taken = new Set(names);
  const seen = new Set<string>();
  return names.map((name) => {
    if (!seen.has(name)) {
      seen.add(name);
      return name;
    }
    let sequence = 0;
    let candidate: string;
    do {
      sequence += 1;
      candidate = `${name}_${sequence}`;
    } while (taken.has(candidate));
    taken.add(candidate);
    return candidate;
  });
}

/**
 * Builds object rows from positional rows and their (already unique) column
 * names. A row that is not an array is passed through unchanged, so a caller
 * can hand over rows a driver (or a test double) already produced as objects.
 *
 * Each row is a null-prototype object: on a plain `{}` a column named
 * `__proto__` would hit the inherited prototype setter instead of becoming an
 * own property, and its value would be lost. Consumers only read properties
 * and JSON-serialise rows, which both work the same without `Object.prototype`.
 */
export function rowsFromArrays(
  columnNames: readonly string[],
  rows: readonly unknown[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    if (!Array.isArray(row)) {
      return row as Record<string, unknown>;
    }
    const object: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < columnNames.length; i++) {
      object[columnNames[i]] = row[i];
    }
    return object;
  });
}

/**
 * Convenience for the common case: unique-ify the driver's column names, then
 * rebuild the rows under them.
 */
export function objectRows(
  columnNames: readonly string[],
  rows: readonly unknown[]
): Record<string, unknown>[] {
  return rowsFromArrays(uniqueColumnNames(columnNames), rows);
}
