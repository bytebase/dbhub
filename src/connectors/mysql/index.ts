import mysql from "mysql2/promise";
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
import { splitSQLStatements } from "../../utils/sql-parser.js";
import { quoteIdentifier } from "../../utils/identifier-quoter.js";

/**
 * MySQL DSN Parser
 * Handles DSN strings like: mysql://user:password@localhost:3306/dbname?sslmode=require
 * Supported SSL modes:
 * - sslmode=disable: No SSL connection
 * - sslmode=require: SSL connection without certificate verification
 * - Any other value: Standard SSL connection with certificate verification
 */
class MySQLDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<mysql.ConnectionOptions> {
    const connectionTimeoutSeconds = config?.connectionTimeoutSeconds;
    // Capture these before the local `config` (mysql.ConnectionOptions) shadows the param below
    const timezone = config?.timezone;
    const charset = config?.charset;
    const collation = config?.collation;
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid MySQL DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      // Use the SafeURL helper instead of the built-in URL
      // This will handle special characters in passwords, etc.
      const url = new SafeURL(dsn);

      const config: mysql.ConnectionOptions = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 3306,
        database: url.pathname ? url.pathname.substring(1) : '', // Remove leading '/' if exists
        user: url.username,
        password: url.password,
        multipleStatements: true, // Enable native multi-statement support
        supportBigNumbers: true, // Return BIGINT as string when value exceeds Number.MAX_SAFE_INTEGER
      };

      // Handle query parameters
      url.forEachSearchParam((value, key) => {
        if (key === "sslmode") {
          if (value === "disable") {
            config.ssl = undefined;
          } else if (value === "require") {
            config.ssl = { rejectUnauthorized: false };
          } else {
            config.ssl = {};
          }
        }
        // Add other parameters as needed
      });

      // Apply connection timeout if specified
      if (connectionTimeoutSeconds !== undefined) {
        // mysql2 library expects connectTimeout in milliseconds
        config.connectTimeout = connectionTimeoutSeconds * 1000;
      }

      // Apply timezone if specified: controls how mysql2 interprets DATETIME values
      // ("Z", "local", or "±HH:MM"). Without it, mysql2 assumes "local", which can
      // produce an incorrect instant when the server timezone differs from the data's.
      if (timezone !== undefined) {
        config.timezone = timezone;
      }

      // Apply charset / collation if specified. mysql2 exposes a single `charset`
      // connection option (it has no separate `collation` option) that accepts
      // either a character set (e.g. "utf8mb4") or a collation (e.g.
      // "utf8mb4_0900_ai_ci") name — see its typings. Both resolve to one
      // connection collation id: a collation implies its character set, so when a
      // collation is configured we pass that (it sets both character_set_connection
      // and collation_connection); otherwise we pass the charset (which uses that
      // character set's default collation). Without either, mysql2 defaults to
      // utf8mb4_unicode_ci.
      const charsetOrCollation = collation ?? charset;
      if (charsetOrCollation !== undefined) {
        config.charset = charsetOrCollation;
      }

      // Auto-detect AWS IAM authentication tokens and configure cleartext plugin
      // AWS RDS IAM tokens are ~800+ character strings containing "X-Amz-Credential"
      if (url.password && url.password.includes("X-Amz-Credential")) {
        config.authPlugins = {
          mysql_clear_password: () => () => {
            return Buffer.from(url.password + "\0");
          }
        };
        // AWS IAM authentication requires SSL, enable if not already configured
        if (config.ssl === undefined) {
          config.ssl = { rejectUnauthorized: false };
        }
      }

      return config;
    } catch (error) {
      throw new Error(
        `Failed to parse MySQL DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "mysql://root:password@localhost:3306/mysql?sslmode=require";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith('mysql://');
    } catch (error) {
      return false;
    }
  }
}

/**
 * MySQL Connector Implementation
 */
export class MySQLConnector implements Connector {
  id: ConnectorType = "mysql";
  name = "MySQL";
  dsnParser = new MySQLDSNParser();

  private pool: mysql.Pool | null = null;
  // Source ID is set by ConnectorManager after cloning
  private sourceId: string = "default";
  private queryTimeoutMs?: number;

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new MySQLConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const connectionOptions = await this.dsnParser.parse(dsn, config);
      this.pool = mysql.createPool(connectionOptions);

      // Store query timeout for per-query application
      if (config?.queryTimeoutSeconds !== undefined) {
        this.queryTimeoutMs = config.queryTimeoutSeconds * 1000;
      }

      // Test the connection
      const [rows] = await this.pool.query("SELECT 1");
    } catch (err) {
      console.error("Failed to connect to MySQL database:", err);
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
      // In MySQL, schemas are equivalent to databases. Exclude server-level
      // system databases so the list matches the user-facing schemas only
      // (parity with the PostgreSQL connector, which hides pg_catalog et al.).
      const [rows] = (await this.pool.query(`
        SELECT SCHEMA_NAME
        FROM INFORMATION_SCHEMA.SCHEMATA
        WHERE SCHEMA_NAME NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
        ORDER BY SCHEMA_NAME
      `)) as [any[], any];

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
      // In MySQL, if no schema is provided, use the current active database (DATABASE())
      // MySQL uses the terms 'database' and 'schema' interchangeably
      // The DATABASE() function returns the current database context
      const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema] : [];

      // Get all tables from the specified schema or current database (excludes views)
      const [rows] = (await this.pool.query(
        `
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        ${schemaClause}
        AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
      `,
        queryParams
      )) as [any[], any];

      return rows.map((row) => row.TABLE_NAME);
    } catch (error) {
      console.error("Error getting tables:", error);
      throw error;
    }
  }

  async getViews(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";
      const queryParams = schema ? [schema] : [];

      const [rows] = (await this.pool.query(
        `
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        ${schemaClause}
        AND TABLE_TYPE = 'VIEW'
        ORDER BY TABLE_NAME
      `,
        queryParams
      )) as [any[], any];

      return rows.map((row) => row.TABLE_NAME);
    } catch (error) {
      console.error("Error getting views:", error);
      throw error;
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MySQL, if no schema is provided, use the current active database
      // DATABASE() function returns the name of the current database
      const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema, tableName] : [tableName];

      const [rows] = (await this.pool.query(
        `
        SELECT COUNT(*) AS COUNT
        FROM INFORMATION_SCHEMA.TABLES 
        ${schemaClause} 
        AND TABLE_NAME = ?
      `,
        queryParams
      )) as [any[], any];

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
      // In MySQL, if no schema is provided, use the current active database
      const schemaClause = schema ? "TABLE_SCHEMA = ?" : "TABLE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema, tableName] : [tableName];

      // Get information about indexes
      const [indexRows] = (await this.pool.query(
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
      )) as [any[], any];

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
        const isUnique = row.NON_UNIQUE === 0; // In MySQL, NON_UNIQUE=0 means the index is unique
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
      // In MySQL, schema is synonymous with database
      // If no schema is provided, use the current database context via DATABASE() function
      // This means tables will be retrieved from whatever database the connection is currently using
      const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema, tableName] : [tableName];

      // Get table columns with comments
      const [rows] = (await this.pool.query(
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
      )) as [any[], any];

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

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaClause = schema ? "WHERE TABLE_SCHEMA = ?" : "WHERE TABLE_SCHEMA = DATABASE()";
      const queryParams = schema ? [schema, tableName] : [tableName];

      const [rows] = (await this.pool.query(
        `
        SELECT TABLE_COMMENT
        FROM INFORMATION_SCHEMA.TABLES
        ${schemaClause}
        AND TABLE_NAME = ?
      `,
        queryParams
      )) as [any[], any];

      if (rows.length > 0) {
        return rows[0].TABLE_COMMENT || null;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  async getStoredProcedures(schema?: string, routineType?: "procedure" | "function"): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MySQL, if no schema is provided, use the current database context
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
      const [rows] = (await this.pool.query(
        `
        SELECT ROUTINE_NAME
        FROM INFORMATION_SCHEMA.ROUTINES
        ${schemaClause}${typeFilter}
        ORDER BY ROUTINE_NAME
      `,
        queryParams
      )) as [any[], any];

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
      // In MySQL, if no schema is provided, use the current database context
      const schemaClause = schema
        ? "WHERE r.ROUTINE_SCHEMA = ?"
        : "WHERE r.ROUTINE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema, procedureName] : [procedureName];

      // Get details of the stored procedure
      const [rows] = (await this.pool.query(
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
      )) as [any[], any];

      if (rows.length === 0) {
        const schemaName = schema || "current schema";
        throw new Error(`Stored procedure '${procedureName}' not found in ${schemaName}`);
      }

      const procedure = rows[0];

      // If ROUTINE_DEFINITION is NULL, try to get the procedure body from mysql.proc
      let definition = procedure.ROUTINE_DEFINITION;

      try {
        const schemaValue = schema || (await this.getCurrentSchema());

        // For full definition - different approaches based on type
        const quotedSchema = quoteIdentifier(schemaValue, "mysql");
        const quotedProcName = quoteIdentifier(procedureName, "mysql");
        if (procedure.procedure_type === "procedure") {
          // Try to get the definition from SHOW CREATE PROCEDURE
          try {
            const [defRows] = (await this.pool.query(`
              SHOW CREATE PROCEDURE ${quotedSchema}.${quotedProcName}
            `)) as [any[], any];

            if (defRows && defRows.length > 0) {
              definition = defRows[0]["Create Procedure"];
            }
          } catch (err) {
            console.error(`Error getting procedure definition with SHOW CREATE: ${err}`);
          }
        } else {
          // Try to get the definition for functions
          try {
            const [defRows] = (await this.pool.query(`
              SHOW CREATE FUNCTION ${quotedSchema}.${quotedProcName}
            `)) as [any[], any];

            if (defRows && defRows.length > 0) {
              definition = defRows[0]["Create Function"];
            }
          } catch (innerErr) {
            console.error(`Error getting function definition with SHOW CREATE: ${innerErr}`);
          }
        }

        // Last attempt - try to get from information_schema.routines if not found yet
        if (!definition) {
          const [bodyRows] = (await this.pool.query(
            `
            SELECT ROUTINE_DEFINITION, ROUTINE_BODY 
            FROM INFORMATION_SCHEMA.ROUTINES
            WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?
          `,
            [schemaValue, procedureName]
          )) as [any[], any];

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
        language: "sql", // MySQL procedures are generally in SQL
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
    const [rows] = (await this.pool!.query("SELECT DATABASE() AS DB")) as [any[], any];
    return rows[0].DB;
  }

  /**
   * Default search scope = the database named in the DSN. DATABASE() returns
   * null when the connection was opened without a database, in which case
   * callers fall back to the full server-wide schema list.
   */
  async getDefaultSchema(): Promise<string | null> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }
    const [rows] = (await this.pool.query("SELECT DATABASE() AS DB")) as [any[], any];
    return rows[0]?.DB ?? null;
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    // Get a dedicated connection from the pool to ensure session consistency
    // This is critical for session-specific features like LAST_INSERT_ID()
    const conn = await this.pool.getConnection();
    try {
      // Engine-level read-only backstop: run the batch inside a READ ONLY
      // transaction so MySQL rejects DML writes (INSERT/UPDATE/DELETE/REPLACE)
      // that the keyword classifier missed (e.g. function-based writes). Note this
      // does NOT stop DDL: statements like DROP/CREATE perform an implicit COMMIT
      // that ends the read-only transaction first, so DDL escapes. Stacked-DDL
      // payloads (e.g. `SELECT 1--1;DROP TABLE t`) are instead rejected upstream by
      // the read-only classifier, which now splits `--`-hidden statements (see
      // scanSingleLineCommentMySQL in sql-parser.ts).
      if (options.readonly) {
        await conn.query("START TRANSACTION READ ONLY");
      }

      // Apply maxRows limit to SELECT queries if specified
      let processedSQL = sql;
      if (options.maxRows) {
        // Handle multi-statement SQL by processing each statement individually
        const statements = splitSQLStatements(sql, "mysql");

        const processedStatements = statements.map(statement =>
          SQLRowLimiter.applyMaxRows(statement, options.maxRows)
        );

        processedSQL = processedStatements.join('; ');
        if (sql.trim().endsWith(';')) {
          processedSQL += ';';
        }
      }

      // Use dedicated connection with multipleStatements: true support
      // Pass parameters if provided, with optional query timeout
      let results: any;
      if (parameters && parameters.length > 0) {
        try {
          results = await conn.query({ sql: processedSQL, timeout: this.queryTimeoutMs }, parameters);
        } catch (error) {
          console.error(`[MySQL executeSQL] ERROR: ${(error as Error).message}`);
          console.error(`[MySQL executeSQL] SQL: ${processedSQL}`);
          console.error(`[MySQL executeSQL] Parameters: ${JSON.stringify(parameters)}`);
          throw error;
        }
      } else {
        results = await conn.query({ sql: processedSQL, timeout: this.queryTimeoutMs });
      }

      // MySQL2 returns results in format [rows, fields]
      // Extract the first element which contains the actual row data
      const [firstResult] = results;

      // Parse results using shared utility that handles both single and multi-statement queries
      const rows = parseQueryResults(firstResult);
      const rowCount = extractAffectedRows(firstResult);

      if (options.readonly) {
        await conn.query("COMMIT");
      }
      return { rows, rowCount };
    } catch (error) {
      if (options.readonly) {
        // Best-effort rollback so the connection returns to the pool clean.
        try {
          await conn.query("ROLLBACK");
        } catch {
          // ignore rollback failure; the original error is more useful
        }
      }
      console.error("Error executing query:", error);
      throw error;
    } finally {
      // Always release the connection back to the pool
      conn.release();
    }
  }
}

// Create and register the connector
const mysqlConnector = new MySQLConnector();
ConnectorRegistry.register(mysqlConnector);
