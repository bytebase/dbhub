import { TableColumn, TableIndex, StoredProcedure } from "./interface.js";
import { quoteIdentifier } from "../utils/identifier-quoter.js";

/**
 * Row-array query adapter, as in mysql-family-health-check.ts: lets MySQL
 * (mysql2, returns [rows, fields]) and MariaDB (mariadb, returns rows directly)
 * share one implementation despite their differing driver response shapes.
 * The connector's adapter also owns the "not connected" check, so every
 * function here may assume a live pool.
 */
export type MySQLFamilyQuery = (sql: string, params?: any[]) => Promise<any[]>;

/**
 * Shared schema-introspection implementation for MySQL and MariaDB. Both
 * engines expose the same INFORMATION_SCHEMA / SHOW CREATE surface, so the
 * connectors differ only in their drivers (DSN parsing, pooling, timeouts and
 * executeSQL), which stay in each connector's index.ts.
 */

export async function getSchemas(query: MySQLFamilyQuery): Promise<string[]> {
  try {
    // In MySQL and MariaDB, schemas are equivalent to databases. Exclude server-level
    // system databases so the list matches the user-facing schemas only
    // (parity with the PostgreSQL connector, which hides pg_catalog et al.).
    const rows = await query(`
      SELECT SCHEMA_NAME
      FROM INFORMATION_SCHEMA.SCHEMATA
      WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
      ORDER BY SCHEMA_NAME
    `);

    return rows.map((row) => row.SCHEMA_NAME);
  } catch (error) {
    console.error("Error getting schemas:", error);
    throw error;
  }
}

export async function getTables(query: MySQLFamilyQuery, schema?: string): Promise<string[]> {
  try {
    // In MySQL and MariaDB, if no schema is provided, use the current active database (DATABASE())
    // MySQL uses the terms 'database' and 'schema' interchangeably
    // The DATABASE() function returns the current database context
    const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";

    const queryParams = schema ? [schema] : [];

    // Get all tables from the specified schema or current database (excludes views)
    const rows = await query(
      `
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      ${schemaClause}
      AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME
    `,
      queryParams
    );

    return rows.map((row) => row.TABLE_NAME);
  } catch (error) {
    console.error("Error getting tables:", error);
    throw error;
  }
}

export async function getViews(query: MySQLFamilyQuery, schema?: string): Promise<string[]> {
  try {
    const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";
    const queryParams = schema ? [schema] : [];

    const rows = await query(
      `
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      ${schemaClause}
      AND TABLE_TYPE = 'VIEW'
      ORDER BY TABLE_NAME
    `,
      queryParams
    );

    return rows.map((row) => row.TABLE_NAME);
  } catch (error) {
    console.error("Error getting views:", error);
    throw error;
  }
}

export async function tableExists(query: MySQLFamilyQuery, tableName: string, schema?: string): Promise<boolean> {
  try {
    // In MySQL and MariaDB, if no schema is provided, use the current active database
    // DATABASE() function returns the name of the current database
    const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";

    const queryParams = schema ? [schema, tableName] : [tableName];

    const rows = await query(
      `
      SELECT COUNT(*) AS COUNT
      FROM INFORMATION_SCHEMA.TABLES 
      ${schemaClause} 
      AND TABLE_NAME = ?
    `,
      queryParams
    );

    return rows[0].COUNT > 0;
  } catch (error) {
    console.error("Error checking if table exists:", error);
    throw error;
  }
}

export async function getTableIndexes(query: MySQLFamilyQuery, tableName: string, schema?: string): Promise<TableIndex[]> {
  try {
    // In MySQL and MariaDB, if no schema is provided, use the current active database
    const schemaClause = schema ? "TABLE_SCHEMA = ?" : "TABLE_SCHEMA = DATABASE()";

    const queryParams = schema ? [schema, tableName] : [tableName];

    // Get information about indexes
    const indexRows = await query(
      `
      SELECT 
        INDEX_NAME,
        COLUMN_NAME,
        NON_UNIQUE,
        SEQ_IN_INDEX
      FROM 
        INFORMATION_SCHEMA.STATISTICS 
      WHERE 
        ${schemaClause}
        AND TABLE_NAME = ? 
      ORDER BY 
        INDEX_NAME, 
        SEQ_IN_INDEX
    `,
      queryParams
    );

    // Process the results to group columns by index
    const indexMap = new Map<
      string,
      {
        columns: string[];
        is_unique: boolean;
        is_primary: boolean;
      }
    >();

    for (const row of indexRows) {
      const indexName = row.INDEX_NAME;
      const columnName = row.COLUMN_NAME;
      const isUnique = row.NON_UNIQUE === 0; // In MySQL and MariaDB, NON_UNIQUE=0 means the index is unique
      const isPrimary = indexName === "PRIMARY";

      if (!indexMap.has(indexName)) {
        indexMap.set(indexName, {
          columns: [],
          is_unique: isUnique,
          is_primary: isPrimary,
        });
      }

      const indexInfo = indexMap.get(indexName)!;
      indexInfo.columns.push(columnName);
    }

    // Convert the map to the expected TableIndex format
    const results: TableIndex[] = [];
    indexMap.forEach((indexInfo, indexName) => {
      results.push({
        index_name: indexName,
        column_names: indexInfo.columns,
        is_unique: indexInfo.is_unique,
        is_primary: indexInfo.is_primary,
      });
    });

    return results;
  } catch (error) {
    console.error("Error getting table indexes:", error);
    throw error;
  }
}

export async function getTableSchema(query: MySQLFamilyQuery, tableName: string, schema?: string): Promise<TableColumn[]> {
  try {
    // In MySQL and MariaDB, schema is synonymous with database
    // If no schema is provided, use the current database context via DATABASE() function
    // This means tables will be retrieved from whatever database the connection is currently using
    const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";

    const queryParams = schema ? [schema, tableName] : [tableName];

    // Get table columns with comments
    const rows = await query(
      `
      SELECT
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default,
        COLUMN_COMMENT as description
      FROM INFORMATION_SCHEMA.COLUMNS
      ${schemaClause}
      AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `,
      queryParams
    );

    // Normalize empty string comments to null for token-efficient output
    return rows.map((row: any) => ({
      ...row,
      description: row.description || null,
    }));
  } catch (error) {
    console.error("Error getting table schema:", error);
    throw error;
  }
}

export async function getTableComment(query: MySQLFamilyQuery, tableName: string, schema?: string): Promise<string | null> {
  try {
    const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";
    const queryParams = schema ? [schema, tableName] : [tableName];

    const rows = await query(
      `
      SELECT TABLE_COMMENT
      FROM INFORMATION_SCHEMA.TABLES
      ${schemaClause}
      AND TABLE_NAME = ?
    `,
      queryParams
    );

    if (rows.length > 0) {
      return rows[0].TABLE_COMMENT || null;
    }
    return null;
  } catch (error) {
    return null;
  }
}

export async function getStoredProcedures(query: MySQLFamilyQuery, schema?: string, routineType?: "procedure" | "function"): Promise<string[]> {
  try {
    // In MySQL and MariaDB, if no schema is provided, use the current database context
    const schemaClause = schema
      ? "WHERE ROUTINE_SCHEMA = ?"
      : "WHERE ROUTINE_SCHEMA = DATABASE()";

    const queryParams: string[] = schema ? [schema] : [];

    // Build optional routine type filter
    let typeFilter = "";
    if (routineType === "function") {
      typeFilter = " AND ROUTINE_TYPE = 'FUNCTION'";
    } else if (routineType === "procedure") {
      typeFilter = " AND ROUTINE_TYPE = 'PROCEDURE'";
    }

    // Get stored procedures and/or functions
    const rows = await query(
      `
      SELECT ROUTINE_NAME
      FROM INFORMATION_SCHEMA.ROUTINES
      ${schemaClause}${typeFilter}
      ORDER BY ROUTINE_NAME
    `,
      queryParams
    );

    return rows.map((row) => row.ROUTINE_NAME);
  } catch (error) {
    console.error("Error getting stored procedures:", error);
    throw error;
  }
}

export async function getStoredProcedureDetail(query: MySQLFamilyQuery, procedureName: string, schema?: string): Promise<StoredProcedure> {
  try {
    // In MySQL and MariaDB, if no schema is provided, use the current database context
    const schemaClause = schema
      ? "WHERE r.ROUTINE_SCHEMA = ?"
      : "WHERE r.ROUTINE_SCHEMA = DATABASE()";

    const queryParams = schema ? [schema, procedureName] : [procedureName];

    // Get details of the stored procedure
    const rows = await query(
      `
      SELECT 
        r.ROUTINE_NAME AS procedure_name,
        CASE 
          WHEN r.ROUTINE_TYPE = 'PROCEDURE' THEN 'procedure'
          ELSE 'function'
        END AS procedure_type,
        LOWER(r.ROUTINE_TYPE) AS routine_type,
        r.ROUTINE_DEFINITION,
        r.DTD_IDENTIFIER AS return_type,
        (
          SELECT GROUP_CONCAT(
            CONCAT(p.PARAMETER_NAME, ' ', p.PARAMETER_MODE, ' ', p.DATA_TYPE)
            ORDER BY p.ORDINAL_POSITION
            SEPARATOR ', '
          )
          FROM INFORMATION_SCHEMA.PARAMETERS p
          WHERE p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA
          AND p.SPECIFIC_NAME = r.ROUTINE_NAME
          AND p.PARAMETER_NAME IS NOT NULL
        ) AS parameter_list
      FROM INFORMATION_SCHEMA.ROUTINES r
      ${schemaClause}
      AND r.ROUTINE_NAME = ?
    `,
      queryParams
    );

    if (rows.length === 0) {
      const schemaName = schema || "current schema";
      throw new Error(`Stored procedure '${procedureName}' not found in ${schemaName}`);
    }

    const procedure = rows[0];

    // If ROUTINE_DEFINITION is NULL, try to get the procedure body from mysql.proc
    let definition = procedure.ROUTINE_DEFINITION;

    try {
      const schemaValue = schema || (await getCurrentSchema(query));

      // For full definition - different approaches based on type
      const quotedSchema = quoteIdentifier(schemaValue, "mysql");
      const quotedProcName = quoteIdentifier(procedureName, "mysql");
      if (procedure.procedure_type === "procedure") {
        // Try to get the definition from SHOW CREATE PROCEDURE
        try {
          const defRows = await query(`
            SHOW CREATE PROCEDURE ${quotedSchema}.${quotedProcName}
          `);

          if (defRows && defRows.length > 0) {
            definition = defRows[0]["Create Procedure"];
          }
        } catch (err) {
          console.error(`Error getting procedure definition with SHOW CREATE: ${err}`);
        }
      } else {
        // Try to get the definition for functions
        try {
          const defRows = await query(`
            SHOW CREATE FUNCTION ${quotedSchema}.${quotedProcName}
          `);

          if (defRows && defRows.length > 0) {
            definition = defRows[0]["Create Function"];
          }
        } catch (innerErr) {
          console.error(`Error getting function definition with SHOW CREATE: ${innerErr}`);
        }
      }

      // Last attempt - try to get from information_schema.routines if not found yet
      if (!definition) {
        const bodyRows = await query(
          `
          SELECT ROUTINE_DEFINITION, ROUTINE_BODY 
          FROM INFORMATION_SCHEMA.ROUTINES
          WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?
        `,
          [schemaValue, procedureName]
        );

        if (bodyRows && bodyRows.length > 0) {
          if (bodyRows[0].ROUTINE_DEFINITION) {
            definition = bodyRows[0].ROUTINE_DEFINITION;
          } else if (bodyRows[0].ROUTINE_BODY) {
            definition = bodyRows[0].ROUTINE_BODY;
          }
        }
      }
    } catch (error) {
      // Ignore errors when getting definition - it's optional
      console.error(`Error getting procedure/function details: ${error}`);
    }

    return {
      procedure_name: procedure.procedure_name,
      procedure_type: procedure.procedure_type,
      language: "sql", // MySQL/MariaDB procedures are generally in SQL
      parameter_list: procedure.parameter_list || "",
      return_type: procedure.routine_type === "function" ? procedure.return_type : undefined,
      definition: definition || undefined,
    };
  } catch (error) {
    console.error("Error getting stored procedure detail:", error);
    throw error;
  }
}

/** Current schema (database) name, for the SHOW CREATE fallbacks above. */
async function getCurrentSchema(query: MySQLFamilyQuery): Promise<string> {
  const rows = await query("SELECT DATABASE() AS DB");
  return rows[0].DB;
}

/**
 * Default search scope = the database named in the DSN. DATABASE() returns
 * null when the connection was opened without a database, in which case
 * callers fall back to the full server-wide schema list.
 */
export async function getDefaultSchema(query: MySQLFamilyQuery): Promise<string | null> {
  const rows = await query("SELECT DATABASE() AS DB");
  return rows[0]?.DB ?? null;
}
