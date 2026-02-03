import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import type { Connector } from "../connectors/interface.js";
import { quoteQualifiedIdentifier } from "../utils/identifier-quoter.js";
import {
  getEffectiveSourceId,
  trackToolRequest,
} from "../utils/tool-handler-helpers.js";

/**
 * Object types that can be searched
 */
export type DatabaseObjectType = "schema" | "table" | "column" | "procedure" | "index";

/**
 * Detail level for search results
 * - names: Just object names (minimal tokens)
 * - summary: Names + brief metadata (row count, column count, etc.)
 * - full: Complete structure details
 */
export type DetailLevel = "names" | "summary" | "full";

// Schema for search_objects tool (unified search and list)
export const searchDatabaseObjectsSchema = {
  object_type: z
    .enum(["schema", "table", "column", "procedure", "index"])
    .describe("Object type to search"),
  pattern: z
    .string()
    .optional()
    .default("%")
    .describe("LIKE pattern (% = any chars, _ = one char). Default: %"),
  schema: z
    .string()
    .optional()
    .describe("Filter to schema"),
  table: z
    .string()
    .optional()
    .describe("Filter to table (requires schema; column/index only)"),
  detail_level: z
    .enum(["names", "summary", "full"])
    .default("names")
    .describe("Detail: names (minimal), summary (metadata), full (all)"),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(100)
    .describe("Max results (default: 100, max: 1000)"),
};

/**
 * Convert SQL LIKE pattern to JavaScript regex
 * Supports % (any chars) and _ (single char)
 */
function likePatternToRegex(pattern: string): RegExp {
  // Escape special regex characters except % and _
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");

  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Get row count estimate for a table
 */
async function getTableRowCount(
  connector: Connector,
  tableName: string,
  schemaName?: string
): Promise<number | null> {
  try {
    // Use proper identifier quoting to handle special characters and reserved keywords
    const qualifiedTable = quoteQualifiedIdentifier(tableName, schemaName, connector.id);
    const countQuery = `SELECT COUNT(*) as count FROM ${qualifiedTable}`;
    const result = await connector.executeSQL(countQuery, { maxRows: 1 });

    if (result.rows && result.rows.length > 0) {
      return Number(result.rows[0].count || result.rows[0].COUNT || 0);
    }
  } catch (error) {
    // If we can't get row count, return null (not critical)
    return null;
  }
  return null;
}

/**
 * Search for schemas
 */
async function searchSchemas(
  connector: Connector,
  pattern: string,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const schemas = await connector.getSchemas();
  const regex = likePatternToRegex(pattern);
  const matched = schemas.filter((schema: string) => regex.test(schema)).slice(0, limit);

  if (detailLevel === "names") {
    return matched.map((name: string) => ({ name }));
  }

  // For summary and full, add table count
  const results = await Promise.all(
    matched.map(async (schemaName: string) => {
      try {
        const tables = await connector.getTables(schemaName);
        return {
          name: schemaName,
          table_count: tables.length,
        };
      } catch (error) {
        return {
          name: schemaName,
          table_count: 0,
        };
      }
    })
  );

  return results;
}

/**
 * Search for tables
 */
async function searchTables(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    schemasToSearch = await connector.getSchemas();
  }

  // Search tables in each schema
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      const tables = await connector.getTables(schemaName);
      const matched = tables.filter((table: string) => regex.test(table));

      for (const tableName of matched) {
        if (results.length >= limit) break;

        if (detailLevel === "names") {
          results.push({
            name: tableName,
            schema: schemaName,
          });
        } else if (detailLevel === "summary") {
          // Get column count for summary
          try {
            const columns = await connector.getTableSchema(tableName, schemaName);
            const rowCount = await getTableRowCount(connector, tableName, schemaName);

            results.push({
              name: tableName,
              schema: schemaName,
              column_count: columns.length,
              row_count: rowCount,
            });
          } catch (error) {
            results.push({
              name: tableName,
              schema: schemaName,
              column_count: null,
              row_count: null,
            });
          }
        } else {
          // full detail
          try {
            const columns = await connector.getTableSchema(tableName, schemaName);
            const indexes = await connector.getTableIndexes(tableName, schemaName);
            const rowCount = await getTableRowCount(connector, tableName, schemaName);

            results.push({
              name: tableName,
              schema: schemaName,
              column_count: columns.length,
              row_count: rowCount,
              columns: columns.map((col: any) => ({
                name: col.column_name,
                type: col.data_type,
                nullable: col.is_nullable === "YES",
                default: col.column_default,
              })),
              indexes: indexes.map((idx: any) => ({
                name: idx.index_name,
                columns: idx.column_names,
                unique: idx.is_unique,
                primary: idx.is_primary,
              })),
            });
          } catch (error) {
            results.push({
              name: tableName,
              schema: schemaName,
              error: `Unable to fetch full details: ${(error as Error).message}`,
            });
          }
        }
      }
    } catch (error) {
      // Skip schemas we can't access
      continue;
    }
  }

  return results;
}

/**
 * Search for columns
 */
async function searchColumns(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  tableFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    schemasToSearch = await connector.getSchemas();
  }

  // Search columns in tables across schemas
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      // Get tables to search
      let tablesToSearch: string[];
      if (tableFilter) {
        // If table filter is specified, only search that table
        tablesToSearch = [tableFilter];
      } else {
        // Otherwise search all tables in the schema
        tablesToSearch = await connector.getTables(schemaName);
      }

      for (const tableName of tablesToSearch) {
        if (results.length >= limit) break;

        try {
          const columns = await connector.getTableSchema(tableName, schemaName);
          const matchedColumns = columns.filter((col: any) => regex.test(col.column_name));

          for (const column of matchedColumns) {
            if (results.length >= limit) break;

            if (detailLevel === "names") {
              results.push({
                name: column.column_name,
                table: tableName,
                schema: schemaName,
              });
            } else {
              // summary and full are the same for columns
              results.push({
                name: column.column_name,
                table: tableName,
                schema: schemaName,
                type: column.data_type,
                nullable: column.is_nullable === "YES",
                default: column.column_default,
              });
            }
          }
        } catch (error) {
          // Skip tables we can't access
          continue;
        }
      }
    } catch (error) {
      // Skip schemas we can't access
      continue;
    }
  }

  return results;
}

/**
 * Search for stored procedures
 */
async function searchProcedures(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    schemasToSearch = await connector.getSchemas();
  }

  // Search procedures in each schema
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      const procedures = await connector.getStoredProcedures(schemaName);
      const matched = procedures.filter((proc: string) => regex.test(proc));

      for (const procName of matched) {
        if (results.length >= limit) break;

        if (detailLevel === "names") {
          results.push({
            name: procName,
            schema: schemaName,
          });
        } else {
          // summary and full - get procedure details
          try {
            const details = await connector.getStoredProcedureDetail(procName, schemaName);
            results.push({
              name: procName,
              schema: schemaName,
              type: details.procedure_type,
              language: details.language,
              parameters: detailLevel === "full" ? details.parameter_list : undefined,
              return_type: details.return_type,
              definition: detailLevel === "full" ? details.definition : undefined,
            });
          } catch (error) {
            results.push({
              name: procName,
              schema: schemaName,
              error: `Unable to fetch details: ${(error as Error).message}`,
            });
          }
        }
      }
    } catch (error) {
      // Skip schemas we can't access or databases that don't support procedures
      continue;
    }
  }

  return results;
}

/**
 * Search for indexes
 */
async function searchIndexes(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  tableFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    schemasToSearch = await connector.getSchemas();
  }

  // Search indexes in tables across schemas
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      // Get tables to search
      let tablesToSearch: string[];
      if (tableFilter) {
        // If table filter is specified, only search that table
        tablesToSearch = [tableFilter];
      } else {
        // Otherwise search all tables in the schema
        tablesToSearch = await connector.getTables(schemaName);
      }

      for (const tableName of tablesToSearch) {
        if (results.length >= limit) break;

        try {
          const indexes = await connector.getTableIndexes(tableName, schemaName);
          const matchedIndexes = indexes.filter((idx: any) => regex.test(idx.index_name));

          for (const index of matchedIndexes) {
            if (results.length >= limit) break;

            if (detailLevel === "names") {
              results.push({
                name: index.index_name,
                table: tableName,
                schema: schemaName,
              });
            } else {
              // summary and full are the same for indexes
              results.push({
                name: index.index_name,
                table: tableName,
                schema: schemaName,
                columns: index.column_names,
                unique: index.is_unique,
                primary: index.is_primary,
              });
            }
          }
        } catch (error) {
          // Skip tables we can't access
          continue;
        }
      }
    } catch (error) {
      // Skip schemas we can't access
      continue;
    }
  }

  return results;
}

/**
 * Create a search_database_objects tool handler
 */
export function createSearchDatabaseObjectsToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const {
      object_type,
      pattern = "%",
      schema,
      table,
      detail_level = "names",
      limit = 100,
    } = args as {
      object_type: DatabaseObjectType;
      pattern?: string;
      schema?: string;
      table?: string;
      detail_level: DetailLevel;
      limit: number;
    };

    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      // Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(sourceId);

      const connector = ConnectorManager.getCurrentConnector(sourceId);

      // Tool is already registered, so it's enabled (no need to check)

      // Validate table parameter
      if (table) {
        if (!schema) {
          success = false;
          errorMessage = "The 'table' parameter requires 'schema' to be specified";
          return createToolErrorResponse(errorMessage, "SCHEMA_REQUIRED");
        }
        if (!["column", "index"].includes(object_type)) {
          success = false;
          errorMessage = `The 'table' parameter only applies to object_type 'column' or 'index', not '${object_type}'`;
          return createToolErrorResponse(errorMessage, "INVALID_TABLE_FILTER");
        }
      }

      // Validate schema if provided
      if (schema) {
        const schemas = await connector.getSchemas();
        if (!schemas.includes(schema)) {
          success = false;
          errorMessage = `Schema '${schema}' does not exist. Available schemas: ${schemas.join(", ")}`;
          return createToolErrorResponse(errorMessage, "SCHEMA_NOT_FOUND");
        }
      }

      let results: any[] = [];

      // Route to appropriate search function
      switch (object_type) {
        case "schema":
          results = await searchSchemas(connector, pattern, detail_level, limit);
          break;
        case "table":
          results = await searchTables(connector, pattern, schema, detail_level, limit);
          break;
        case "column":
          results = await searchColumns(connector, pattern, schema, table, detail_level, limit);
          break;
        case "procedure":
          results = await searchProcedures(connector, pattern, schema, detail_level, limit);
          break;
        case "index":
          results = await searchIndexes(connector, pattern, schema, table, detail_level, limit);
          break;
        default:
          success = false;
          errorMessage = `Unsupported object_type: ${object_type}`;
          return createToolErrorResponse(errorMessage, "INVALID_OBJECT_TYPE");
      }

      return createToolSuccessResponse({
        object_type,
        pattern,
        schema,
        table,
        detail_level,
        count: results.length,
        results,
        truncated: results.length === limit,
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(
        `Error searching database objects: ${errorMessage}`,
        "SEARCH_ERROR"
      );
    } finally {
      // Track the request
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: effectiveSourceId === "default" ? "search_objects" : `search_objects_${effectiveSourceId}`,
          sql: `search_objects(object_type=${object_type}, pattern=${pattern}, schema=${schema || "all"}, table=${table || "all"}, detail_level=${detail_level})`,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
