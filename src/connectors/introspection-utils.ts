import type { TableIndex } from "./interface.js";

/**
 * One row of a catalog query that lists an index a column at a time.
 */
export interface IndexColumnRow {
  indexName: string;
  columnName: string;
  isUnique: boolean;
  isPrimary: boolean;
}

/**
 * Fold catalog rows that name one index column each into one TableIndex per
 * index. Rows are expected in index order, then column position, which is how
 * every connector's query sorts them; columns are kept in the order received,
 * and an index's uniqueness and primary-key flags are taken from its first row.
 *
 * `describe` reads the four values out of the driver's row shape, which
 * differs per catalog (INFORMATION_SCHEMA.STATISTICS, sys.indexes,
 * ALL_INDEXES, ...).
 */
export function groupIndexColumns<Row>(
  rows: Iterable<Row>,
  describe: (row: Row) => IndexColumnRow
): TableIndex[] {
  const indexes = new Map<string, TableIndex>();
  for (const row of rows) {
    const { indexName, columnName, isUnique, isPrimary } = describe(row);
    let index = indexes.get(indexName);
    if (!index) {
      index = {
        index_name: indexName,
        column_names: [],
        is_unique: isUnique,
        is_primary: isPrimary,
      };
      indexes.set(indexName, index);
    }
    index.column_names.push(columnName);
  }
  return Array.from(indexes.values());
}
