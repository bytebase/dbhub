/**
 * Multi-Statement Result Parser Utility
 *
 * Provides shared logic for parsing multi-statement SQL execution results
 * from different database drivers (MariaDB, MySQL2) that have similar but
 * slightly different result formats, into a list of per-statement result sets.
 */

import type { SQLResultSet } from "../connectors/interface.js";

/**
 * Checks if an element is a metadata object from INSERT/UPDATE/DELETE operations
 * rather than a row array from SELECT queries.
 *
 * Different drivers use different property names for metadata:
 * - MariaDB: affectedRows, warningStatus, insertId
 * - MySQL2: affectedRows, insertId, fieldCount, ResultSetHeader type
 */
function isMetadataObject(element: any): boolean {
  if (!element || typeof element !== 'object' || Array.isArray(element)) {
    return false;
  }

  // Check for common metadata properties that indicate this is not a row array
  return 'affectedRows' in element ||
         'insertId' in element ||
         'fieldCount' in element ||
         'warningStatus' in element;
}

/**
 * Checks if results appear to be from a multi-statement query.
 *
 * Multi-statement results are arrays containing mixed types:
 * - Metadata objects (from INSERT/UPDATE/DELETE)
 * - Arrays of rows (from SELECT queries)
 */
function isMultiStatementResult(results: any): boolean {
  if (!Array.isArray(results) || results.length === 0) {
    return false;
  }

  const firstElement = results[0];

  // If first element is metadata or an array, it's a multi-statement result
  return isMetadataObject(firstElement) || Array.isArray(firstElement);
}

/**
 * Builds one `SQLResultSet` per statement from raw multi-statement driver
 * results, preserving statement order. A `SELECT` becomes `{rows, rowCount:
 * rows.length}`; an INSERT/UPDATE/DELETE metadata object becomes `{rows: [],
 * rowCount: affectedRows}`.
 */
function buildResultSetsFromMultiStatement(results: any[]): SQLResultSet[] {
  return results.map((result) => {
    if (Array.isArray(result)) {
      return { rows: result, rowCount: result.length };
    }
    if (isMetadataObject(result)) {
      return { rows: [], rowCount: result.affectedRows || 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

/**
 * Parses raw database query results into a list of per-statement result
 * sets, handling both single and multi-statement queries.
 *
 * This function unifies the result parsing logic for MariaDB and MySQL2
 * drivers, which have similar but slightly different result formats.
 *
 * @param results - Raw results from the database driver
 * @returns One `SQLResultSet` per statement, in execution order
 */
export function parseQueryResultSets(results: any): SQLResultSet[] {
  // Non-array results (e.g. a single INSERT/UPDATE/DELETE without RETURNING)
  if (isMetadataObject(results)) {
    return [{ rows: [], rowCount: results.affectedRows || 0 }];
  }
  if (!Array.isArray(results)) {
    return [{ rows: [], rowCount: 0 }];
  }

  if (isMultiStatementResult(results)) {
    return buildResultSetsFromMultiStatement(results);
  }

  // Single statement result - results is the rows array directly
  return [{ rows: results, rowCount: results.length }];
}
