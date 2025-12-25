import mariadb from "mariadb";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { parseQueryResults, extractAffectedRows } from "../../utils/multi-statement-result-parser.js";

/**
 * MariaDB DSN Parser
 * Handles DSN strings like: mariadb://user:password@localhost:3306/dbname?sslmode=require
 * Supported SSL modes:
 * - sslmode=disable: No SSL connection
 * - sslmode=require: SSL connection without certificate verification
 * - Any other value: Standard SSL connection with certificate verification
 */
class MariadbDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<mariadb.ConnectionConfig> {
    const connectionTimeoutSeconds = config?.connectionTimeoutSeconds;
    const queryTimeoutSeconds = config?.queryTimeoutSeconds;
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid MariaDB DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      // Use the SafeURL helper instead of the built-in URL
      // This will handle special characters in passwords, etc.
      const url = new SafeURL(dsn);

      const connectionConfig: mariadb.ConnectionConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 3306,
        database: url.pathname ? url.pathname.substring(1) : '', // Remove leading '/' if exists
        user: url.username,
        password: url.password,
        multipleStatements: true, // Enable native multi-statement support
        ...(connectionTimeoutSeconds !== undefined && {
          connectTimeout: connectionTimeoutSeconds * 1000
        }),
        ...(queryTimeoutSeconds !== undefined && {
          queryTimeout: queryTimeoutSeconds * 1000
        }),
      };

      // Handle query parameters
      url.forEachSearchParam((value, key) => {
        if (key === "sslmode") {
          if (value === "disable") {
            connectionConfig.ssl = undefined;
          } else if (value === "require") {
            connectionConfig.ssl = { rejectUnauthorized: false };
          } else {
            connectionConfig.ssl = {};
          }
        }
        // Add other parameters as needed
      });

      // Auto-detect AWS IAM authentication tokens and ensure SSL is enabled
      // AWS RDS IAM tokens are ~800+ character strings containing "X-Amz-Credential"
      // MariaDB connector includes mysql_clear_password in default permitted plugins,
      // but AWS IAM authentication requires SSL
      if (url.password && url.password.includes("X-Amz-Credential")) {
        // AWS IAM authentication requires SSL, enable if not already configured
        if (connectionConfig.ssl === undefined) {
          connectionConfig.ssl = { rejectUnauthorized: false };
        }
      }

      return connectionConfig;
    } catch (error) {
      throw new Error(
        `Failed to parse MariaDB DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "mariadb://root:password@localhost:3306/db?sslmode=require";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith('mariadb://');
    } catch (error) {
      return false;
    }
  }
}

/**
 * MariaDB Connector Implementation
 */
export class MariaDBConnector implements Connector {
  id: ConnectorType = "mariadb";
  name = "MariaDB";
  dsnParser = new MariadbDSNParser();

  private pool: mariadb.Pool | null = null;
  // Source ID is set by ConnectorManager after cloning
  private sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new MariaDBConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const connectionConfig = await this.dsnParser.parse(dsn, config);

      this.pool = mariadb.createPool(connectionConfig);

      // Test the connection
      await this.pool.query("SELECT 1");
    } catch (err) {
      console.error("Failed to connect to MariaDB database:", err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async getSchemas(): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MariaDB, schemas are equivalent to databases
      const rows = await this.pool.query(`
        SELECT SCHEMA_NAME 
        FROM INFORMATION_SCHEMA.SCHEMATA
        ORDER BY SCHEMA_NAME
      `) as any[];

      return rows.map((row) => row.SCHEMA_NAME);
    } catch (error) {
      console.error("Error getting schemas:", error);
      throw error;
    }
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MariaDB, if no schema is provided, use the current active database (DATABASE())
      // MariaDB uses the terms 'database' and 'schema' interchangeably
      // The DATABASE() function returns the current database context
      const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema] : [];

      // Get all tables from the specified schema or current database
      const rows = await this.pool.query(
        `
        SELECT TABLE_NAME 
        FROM INFORMATION_SCHEMA.TABLES 
        ${schemaClause}
        ORDER BY TABLE_NAME
      `,
        queryParams
      ) as any[];

      return rows.map((row) => row.TABLE_NAME);
    } catch (error) {
      console.error("Error getting tables:", error);
      throw error;
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MariaDB, if no schema is provided, use the current active database
      // DATABASE() function returns the name of the current database
      const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema, tableName] : [tableName];

      const rows = await this.pool.query(
        `
        SELECT COUNT(*) AS COUNT
        FROM INFORMATION_SCHEMA.TABLES 
        ${schemaClause} 
        AND TABLE_NAME = ?
      `,
        queryParams
      ) as any[];

      return rows[0].COUNT > 0;
    } catch (error) {
      console.error("Error checking if table exists:", error);
      throw error;
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MariaDB, if no schema is provided, use the current active database
      const schemaClause = schema ? "TABLE_SCHEMA = ?" : "TABLE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema, tableName] : [tableName];

      // Get information about indexes
      const indexRows = await this.pool.query(
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
      ) as any[];

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
        const isUnique = row.NON_UNIQUE === 0; // In MariaDB, NON_UNIQUE=0 means the index is unique
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

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MariaDB, schema is synonymous with database
      // If no schema is provided, use the current database context via DATABASE() function
      // This means tables will be retrieved from whatever database the connection is currently using
      const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema, tableName] : [tableName];

      // Get table columns
      const rows = await this.pool.query(
        `
        SELECT 
          COLUMN_NAME as column_name, 
          DATA_TYPE as data_type, 
          IS_NULLABLE as is_nullable,
          COLUMN_DEFAULT as column_default
        FROM INFORMATION_SCHEMA.COLUMNS
        ${schemaClause}
        AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `,
        queryParams
      ) as any[];

      return rows;
    } catch (error) {
      console.error("Error getting table schema:", error);
      throw error;
    }
  }

  async getStoredProcedures(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MariaDB, if no schema is provided, use the current database context
      const schemaClause = schema
        ? "WHERE ROUTINE_SCHEMA = ?"
        : "WHERE ROUTINE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema] : [];

      // Get all stored procedures and functions
      const rows = await this.pool.query(
        `
        SELECT ROUTINE_NAME
        FROM INFORMATION_SCHEMA.ROUTINES
        ${schemaClause}
        ORDER BY ROUTINE_NAME
      `,
        queryParams
      ) as any[];

      return rows.map((row) => row.ROUTINE_NAME);
    } catch (error) {
      console.error("Error getting stored procedures:", error);
      throw error;
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MariaDB, if no schema is provided, use the current database context
      const schemaClause = schema
        ? "WHERE r.ROUTINE_SCHEMA = ?"
        : "WHERE r.ROUTINE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema, procedureName] : [procedureName];

      // Get details of the stored procedure
      const rows = await this.pool.query(
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
      ) as any[];

      if (rows.length === 0) {
        const schemaName = schema || "current schema";
        throw new Error(`Stored procedure '${procedureName}' not found in ${schemaName}`);
      }

      const procedure = rows[0];

      // If ROUTINE_DEFINITION is NULL, try to get the procedure body from mariadb.proc
      let definition = procedure.ROUTINE_DEFINITION;

      try {
        const schemaValue = schema || (await this.getCurrentSchema());

        // For full definition - different approaches based on type
        if (procedure.procedure_type === "procedure") {
          // Try to get the definition from SHOW CREATE PROCEDURE
          try {
            const defRows = await this.pool.query(`
              SHOW CREATE PROCEDURE ${schemaValue}.${procedureName}
            `) as any[];

            if (defRows && defRows.length > 0) {
              definition = defRows[0]["Create Procedure"];
            }
          } catch (err) {
            console.error(`Error getting procedure definition with SHOW CREATE: ${err}`);
          }
        } else {
          // Try to get the definition for functions
          try {
            const defRows = await this.pool.query(`
              SHOW CREATE FUNCTION ${schemaValue}.${procedureName}
            `) as any[];

            if (defRows && defRows.length > 0) {
              definition = defRows[0]["Create Function"];
            }
          } catch (innerErr) {
            console.error(`Error getting function definition with SHOW CREATE: ${innerErr}`);
          }
        }

        // Last attempt - try to get from information_schema.routines if not found yet
        if (!definition) {
          const bodyRows = await this.pool.query(
            `
            SELECT ROUTINE_DEFINITION, ROUTINE_BODY 
            FROM INFORMATION_SCHEMA.ROUTINES
            WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?
          `,
            [schemaValue, procedureName]
          ) as any[];

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
        language: "sql", // MariaDB procedures are generally in SQL
        parameter_list: procedure.parameter_list || "",
        return_type: procedure.routine_type === "function" ? procedure.return_type : undefined,
        definition: definition || undefined,
      };
    } catch (error) {
      console.error("Error getting stored procedure detail:", error);
      throw error;
    }
  }

  // Helper method to get current schema (database) name
  private async getCurrentSchema(): Promise<string> {
    const rows = await this.pool!.query("SELECT DATABASE() AS DB") as any[];
    return rows[0].DB;
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    // Get a dedicated connection from the pool to ensure session consistency
    // This is critical for session-specific features like LAST_INSERT_ID()
    const conn = await this.pool.getConnection();
    try {
      // Apply maxRows limit to SELECT queries if specified
      let processedSQL = sql;
      if (options.maxRows) {
        // Handle multi-statement SQL by processing each statement individually
        const statements = sql.split(';')
          .map(statement => statement.trim())
          .filter(statement => statement.length > 0);

        const processedStatements = statements.map(statement =>
          SQLRowLimiter.applyMaxRows(statement, options.maxRows)
        );

        processedSQL = processedStatements.join('; ');
        if (sql.trim().endsWith(';')) {
          processedSQL += ';';
        }
      }

      // Use dedicated connection - MariaDB driver returns rows directly for single statements
      // Pass parameters if provided
      let results: any;
      if (parameters && parameters.length > 0) {
        try {
          results = await conn.query(processedSQL, parameters);
        } catch (error) {
          console.error(`[MariaDB executeSQL] ERROR: ${(error as Error).message}`);
          console.error(`[MariaDB executeSQL] SQL: ${processedSQL}`);
          console.error(`[MariaDB executeSQL] Parameters: ${JSON.stringify(parameters)}`);
          throw error;
        }
      } else {
        results = await conn.query(processedSQL);
      }

      // Parse results using shared utility that handles both single and multi-statement queries
      const rows = parseQueryResults(results);
      const rowCount = extractAffectedRows(results);
      return { rows, rowCount };
    } catch (error) {
      console.error("Error executing query:", error);
      throw error;
    } finally {
      // Always release the connection back to the pool
      conn.release();
    }
  }
}

// Create and register the connector
const mariadbConnector = new MariaDBConnector();
ConnectorRegistry.register(mariadbConnector);
