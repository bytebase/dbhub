import type { ConnectorType } from "../connectors/interface.js";

/**
 * Quote a database identifier (table name, schema name, column name) for safe use in SQL queries.
 * Each database has its own identifier quoting rules:
 * - PostgreSQL/SQLite: Double quotes ("identifier")
 * - MySQL/MariaDB: Backticks (`identifier`)
 * - SQL Server: Square brackets ([identifier])
 *
 * This function handles:
 * 1. Database-specific quoting syntax
 * 2. Escaping of quotes within identifiers
 * 3. Validation against control characters
 *
 * Note: This is for identifiers that come from database metadata (getTables, getSchemas, etc.),
 * not for user input. User input should always use parameterized queries.
 *
 * @param identifier - The identifier to quote (e.g., table name, schema name)
 * @param dbType - The database type (postgres, mysql, mariadb, sqlite, sqlserver)
 * @returns The properly quoted identifier
 * @throws Error if identifier contains null bytes or control characters
 */
export function quoteIdentifier(identifier: string, dbType: ConnectorType): string {
  // Validate: no null bytes or dangerous control characters
  if (/[\0\x08\x09\x1a\n\r]/.test(identifier)) {
    throw new Error(`Invalid identifier: contains control characters: ${identifier}`);
  }

  // Handle empty identifier
  if (!identifier) {
    throw new Error("Identifier cannot be empty");
  }

  switch (dbType) {
    case "postgres":
    case "sqlite":
      // PostgreSQL and SQLite use double quotes
      // Escape existing double quotes by doubling them
      return `"${identifier.replace(/"/g, '""')}"`;

    case "mysql":
    case "mariadb":
      // MySQL and MariaDB use backticks
      // Escape existing backticks by doubling them
      return `\`${identifier.replace(/`/g, "``")}\``;

    case "sqlserver":
      // SQL Server uses square brackets
      // Escape closing brackets by doubling them
      return `[${identifier.replace(/]/g, "]]")}]`;

    default:
      // Fallback to double quotes for unknown database types
      return `"${identifier.replace(/"/g, '""')}"`;
  }
}

/**
 * Quote a qualified identifier (schema.table or database.table)
 *
 * @param tableName - The table name
 * @param schemaName - Optional schema/database name
 * @param dbType - The database type
 * @returns Properly quoted qualified identifier (e.g., "schema"."table")
 */
export function quoteQualifiedIdentifier(
  tableName: string,
  schemaName: string | undefined,
  dbType: ConnectorType
): string {
  const quotedTable = quoteIdentifier(tableName, dbType);

  if (schemaName) {
    const quotedSchema = quoteIdentifier(schemaName, dbType);
    return `${quotedSchema}.${quotedTable}`;
  }

  return quotedTable;
}
