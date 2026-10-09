import sql from "mssql";
import { stripCommentsAndStrings } from "../../utils/sql-parser.js";
import {
  sqlServerDynamicSqlKeywords,
  sqlServerDynamicSqlPattern,
  sqlServerPassThroughKeywords,
  sqlServerPassThroughPattern,
} from "../../utils/allowed-keywords.js";

/**
 * Request-level helpers shared by the SQL Server connector's execution paths
 * (executeSQL / executeReadOnly in index.ts and the EXPLAIN emulation in
 * explain.ts), kept in one place so the paths cannot drift in how they bind
 * parameters or which read-only escapes they reject.
 */

/**
 * Bind positional parameters as @p1, @p2, ... inferring the SQL Server type
 * from each JavaScript value. Shared by every execution path so they cannot
 * drift in how a given value is typed.
 *
 * Works for `batch` as well as `query`: node-mssql prepends the matching
 * DECLARE/SET statements when the request is a batch.
 */
export function bindParameters(request: sql.Request, parameters?: any[]): void {
  if (!parameters || parameters.length === 0) {
    return;
  }

  parameters.forEach((param, index) => {
    const paramName = `p${index + 1}`;
    if (typeof param === 'string') {
      request.input(paramName, sql.VarChar, param);
    } else if (typeof param === 'number') {
      if (Number.isInteger(param)) {
        request.input(paramName, sql.Int, param);
      } else {
        request.input(paramName, sql.Float, param);
      }
    } else if (typeof param === 'boolean') {
      request.input(paramName, sql.Bit, param);
    } else if (param === null || param === undefined) {
      request.input(paramName, sql.VarChar, param);
    } else if (Array.isArray(param)) {
      // For arrays, convert to JSON string
      request.input(paramName, sql.VarChar, JSON.stringify(param));
    } else {
      // For objects, convert to JSON string
      request.input(paramName, sql.VarChar, JSON.stringify(param));
    }
  });
}

/**
 * Reject the constructs that escape SQL Server's read-only guards, for use by
 * both read-only execution paths.
 *
 * - Dynamic SQL (sqlServerDynamicSqlKeywords): can carry hidden COMMIT/ROLLBACK
 *   inside string literals that stripCommentsAndStrings removes
 * - Pass-through data sources (sqlServerPassThroughKeywords): execute on a
 *   remote or ad-hoc source, so a local rollback never reaches them
 * - COMMIT/ROLLBACK, when `transactionControl` is set: would end the wrapping
 *   transaction, letting writes persist. Only meaningful for the transaction
 *   path; the EXPLAIN path opens no transaction of its own.
 *
 * Both keyword lists are imported from the read-only classifier rather than
 * redeclared, so the classifier and these backstops cannot drift apart.
 *
 * Note the COMMIT/ROLLBACK check is SQL Server-only by design. MySQL/MariaDB
 * wrap batches in a transaction too, but there `commit`, `prepare` and
 * `execute` are absent from their allow-lists in allowedKeywords, and
 * execute-sql.ts requires every split statement to pass the classifier — so a
 * transaction-control statement can never reach their backstop.
 */
export function assertNoReadOnlyEscapes(
  sqlText: string,
  { transactionControl = false }: { transactionControl?: boolean } = {},
): void {
  const cleaned = stripCommentsAndStrings(sqlText, "sqlserver").toLowerCase();

  if (transactionControl && /\b(?:commit|rollback)\b/.test(cleaned)) {
    throw new Error(
      "Read-only mode: transaction control statements (COMMIT, ROLLBACK) are not allowed",
    );
  }
  if (sqlServerDynamicSqlPattern.test(cleaned)) {
    throw new Error(
      `Read-only mode: dynamic SQL execution (${sqlServerDynamicSqlKeywords
        .map((k) => k.toUpperCase())
        .join(", ")}) is not allowed`,
    );
  }
  if (sqlServerPassThroughPattern.test(cleaned)) {
    throw new Error(
      `Read-only mode: pass-through data sources (${sqlServerPassThroughKeywords
        .map((k) => k.toUpperCase())
        .join(", ")}) are not allowed`,
    );
  }
}
