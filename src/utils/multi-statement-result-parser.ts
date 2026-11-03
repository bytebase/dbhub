/**
 * Multi-Statement Result Parser Utility
 *
 * Provides shared logic for parsing multi-statement SQL execution results
 * from different database drivers (MariaDB, MySQL2) that have similar but
 * slightly different result formats, into a list of per-statement result sets.
 */

import type { SQLResultSet } from "../connectors/interface.js";
import { objectRows } from "./result-columns.js";

/**
 * The column metadata a driver returns alongside its rows. For a single
 * result set it is a flat list of column descriptors; for a multi-statement
 * batch it is one entry per statement - that statement's descriptor list, or
 * null/undefined for a statement that produced no rows. mysql2 describes a
 * column as `{ name: string }` (FieldPacket), mariadb as an object with a
 * `name()` method (ColumnDefinition).
 */
export type DriverFields = unknown[] | undefined;

/** The column name of a mysql2 FieldPacket or a mariadb ColumnDefinition. */
function columnName(field: any): string {
  const name = typeof field?.name === "function" ? field.name() : field?.name;
  return typeof name === "string" ? name : String(name ?? "");
}

/**
 * Rebuilds object rows from the positional rows the drivers return in array
 * row mode (`rowsAsArray`), under unique column names (see result-columns.ts).
 * Rows that are already objects, and results without column metadata, are
 * returned unchanged.
 */
function toObjectRows(rows: any[], fields: unknown): any[] {
  if (!Array.isArray(fields) || !rows.some(Array.isArray)) {
    return rows;
  }
  return objectRows(fields.map(columnName), rows);
}

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
function isMultiStatementResult(results: any, fields: DriverFields): boolean {
  if (!Array.isArray(results) || results.length === 0) {
    return false;
  }

  const firstElement = results[0];

  if (isMetadataObject(firstElement)) {
    return true;
  }
  if (!Array.isArray(firstElement)) {
    return false;
  }

  // The first element is an array: either the first statement's row list
  // (multi-statement) or, in array row mode, the first row of a single
  // statement. The column metadata tells them apart - a single statement's
  // is a flat list of column descriptors, a batch's has one entry per
  // statement (a list, or null/undefined for a statement without rows).
  if (fields === undefined) {
    return true;
  }
  return fields.every((entry) => entry == null || Array.isArray(entry));
}

/**
 * Builds one `SQLResultSet` per statement from raw multi-statement driver
 * results, preserving statement order. A `SELECT` becomes `{rows, rowCount:
 * rows.length}`; an INSERT/UPDATE/DELETE metadata object becomes `{rows: [],
 * rowCount: affectedRows}`. `statementTexts`, when its length matches the
 * driver's result count, attributes each set to the statement that produced
 * it - both drivers return one entry per statement in source order, so a
 * length match means the pairing is exact, not a guess.
 */
function buildResultSetsFromMultiStatement(
  results: any[],
  statementTexts: string[] | undefined,
  fields: DriverFields
): SQLResultSet[] {
  const sql = statementTexts?.length === results.length ? statementTexts : undefined;
  return results.map((result, index) => {
    if (Array.isArray(result)) {
      const rows = toObjectRows(result, fields?.[index]);
      return { sql: sql?.[index], rows, rowCount: rows.length };
    }
    if (isMetadataObject(result)) {
      return { sql: sql?.[index], rows: [], rowCount: result.affectedRows || 0 };
    }
    return { sql: sql?.[index], rows: [], rowCount: 0 };
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
 * @param statementTexts - The original, source-order statement texts, used
 * to attribute each result set to the statement that produced it
 * @param fields - The driver's column metadata (see `DriverFields`). With it,
 * rows fetched in array row mode are rebuilt as objects under unique column
 * names, so a result with repeated names keeps every column
 * @returns One `SQLResultSet` per statement, in execution order
 */
export function parseQueryResultSets(
  results: any,
  statementTexts?: string[],
  fields?: DriverFields
): SQLResultSet[] {
  const singleStatementSql = statementTexts?.length === 1 ? statementTexts[0] : undefined;

  // Non-array results (e.g. a single INSERT/UPDATE/DELETE without RETURNING)
  if (isMetadataObject(results)) {
    return [{ sql: singleStatementSql, rows: [], rowCount: results.affectedRows || 0 }];
  }
  if (!Array.isArray(results)) {
    return [{ sql: singleStatementSql, rows: [], rowCount: 0 }];
  }

  if (isMultiStatementResult(results, fields)) {
    return buildResultSetsFromMultiStatement(results, statementTexts, fields);
  }

  // Single statement result - results is the rows array directly
  const rows = toObjectRows(results, fields);
  return [{ sql: singleStatementSql, rows, rowCount: rows.length }];
}
