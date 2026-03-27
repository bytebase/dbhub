/**
 * Multi-Statement Result Parser Utility
 *
 * Provides shared logic for parsing multi-statement SQL execution results
 * from different database drivers (MariaDB, MySQL2) that have similar but
 * slightly different result formats.
 */

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
 * Extracts row arrays from multi-statement results, filtering out metadata objects.
 *
 * @param multiStmntResults - The raw results from a multi-statement query
 * @returns Array containing only the rows from SELECT queries
 */
export function extractRowsFromMultiStatement(multiStmntResults: any): any[] {
  if (!Array.isArray(multiStmntResults)) {
    return [];
  }

  const allRows: any[] = [];

  for (const result of multiStmntResults) {
    if (Array.isArray(result)) {
      // This is a row array from a SELECT query - add all rows
      allRows.push(...result);
    }
    // Skip metadata objects from INSERT/UPDATE/DELETE
  }

  return allRows;
}

/**
 * Extracts total affected rows from query results.
 *
 * For INSERT/UPDATE/DELETE operations, returns the sum of affectedRows.
 * For SELECT operations, returns the number of rows.
 *
 * @param affectedRows - Raw results from the database driver
 * @returns Total number of affected/returned rows
 */
export function extractAffectedRows(affectedRows: any): number {
  // Handle metadata object (single INSERT/UPDATE/DELETE)
  if (isMetadataObject(affectedRows)) {
    return affectedRows.affectedRows || 0;
  }

  // Handle non-array results
  if (!Array.isArray(affectedRows)) {
    return 0;
  }

  // Check if this is a multi-statement result
  if (isMultiStatementResult(affectedRows)) {
    let totalAffected = 0;
    for (const result of affectedRows) {
      if (isMetadataObject(result)) {
        totalAffected += result.affectedRows || 0;
      } else if (Array.isArray(result)) {
        totalAffected += result.length;
      }
    }
    return totalAffected;
  }

  // Single statement result - results is the rows array directly
  return affectedRows.length;
}

/**
 * Parses database query results, handling both single and multi-statement queries.
 *
 * This function unifies the result parsing logic for MariaDB and MySQL2 drivers,
 * which have similar but slightly different result formats.
 *
 * @param queryResults - Raw results from the database driver
 * @returns Array of row objects from SELECT queries
 */
export function parseQueryResults(queryResults: any): any[] {
  // Handle non-array results (e.g., from INSERT/UPDATE/DELETE without RETURNING)
  if (!Array.isArray(queryResults)) {
    return [];
  }

  // Check if this is a multi-statement result
  if (isMultiStatementResult(queryResults)) {
    return extractRowsFromMultiStatement(queryResults);
  }

  // Single statement result - results is the rows array directly
  return queryResults;
}
