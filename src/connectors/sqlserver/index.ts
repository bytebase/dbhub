import sql from "mssql";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  DatabaseMessage,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
} from "../interface.js";
import { isDriverNotInstalled } from "../../utils/module-loader.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { stripCommentsAndStrings } from "../../utils/sql-parser.js";
import {
  sqlServerDynamicSqlKeywords,
  sqlServerDynamicSqlPattern,
  sqlServerPassThroughKeywords,
  sqlServerPassThroughPattern,
} from "../../utils/allowed-keywords.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";

/**
 * SQL Server DSN parser
 * Expected format: mssql://username:password@host:port/database
 */
export class SQLServerDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<sql.config> {
    const connectionTimeoutSeconds = config?.connectionTimeoutSeconds;
    const queryTimeoutSeconds = config?.queryTimeoutSeconds;
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid SQL Server DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      // Use the SafeURL helper to parse DSNs with special characters
      const url = new SafeURL(dsn);
      
      // Parse additional options from query parameters
      const options: Record<string, any> = {};
      
      // Process query parameters
      url.forEachSearchParam((value, key) => {
        if (key === "authentication") {
          options.authentication = value;
        } else if (key === "sslmode") {
          options.sslmode = value;
        } else if (key === "instanceName") {
          options.instanceName = value;
        } else if (key === "domain") {
          options.domain = value;
        }
      });

      // Validate NTLM parameter consistency
      if (options.authentication === "ntlm" && !options.domain) {
        throw new Error("NTLM authentication requires 'domain' parameter");
      }
      if (options.domain && options.authentication !== "ntlm") {
        throw new Error("Parameter 'domain' requires 'authentication=ntlm'");
      }
      
      // Handle sslmode parameter similar to PostgreSQL and MySQL
      if (options.sslmode) {
        if (options.sslmode === "disable") {
          options.encrypt = false;
          options.trustServerCertificate = false;
        } else if (options.sslmode === "require") {
          options.encrypt = true;
          options.trustServerCertificate = true;
        }
        // Default behavior (certificate verification) is handled by the default values below
      }
      
      // Base configuration
      const config: sql.config = {
        server: url.hostname,
        port: url.port ? parseInt(url.port) : 1433, // Default SQL Server port
        database: url.pathname ? url.pathname.substring(1) : '', // Remove leading slash
        options: {
          encrypt: options.encrypt ?? false, // Default to unencrypted for development
          trustServerCertificate: options.trustServerCertificate ?? false,
          ...(connectionTimeoutSeconds !== undefined && {
            connectTimeout: connectionTimeoutSeconds * 1000
          }),
          ...(queryTimeoutSeconds !== undefined && {
            requestTimeout: queryTimeoutSeconds * 1000
          }),
          instanceName: options.instanceName, // Add named instance support
        },
      };

      // Handle authentication types
      switch (options.authentication) {
        case "azure-active-directory-access-token": {
          let DefaultAzureCredential: typeof import("@azure/identity")["DefaultAzureCredential"];
          try {
            ({ DefaultAzureCredential } = await import("@azure/identity"));
          } catch (importError) {
            if (isDriverNotInstalled(importError, "@azure/identity")) {
              throw new Error(
                'Azure AD authentication requires the "@azure/identity" package. Install it with: pnpm add @azure/identity'
              );
            }
            throw importError;
          }
          try {
            const credential = new DefaultAzureCredential();
            const token = await credential.getToken("https://database.windows.net/");
            config.authentication = {
              type: "azure-active-directory-access-token",
              options: {
                token: token.token,
              },
            };
          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get Azure AD token: ${errorMessage}`);
          }
          break;
        }
        case "ntlm":
          config.authentication = {
            type: "ntlm",
            options: {
              domain: options.domain,
              userName: url.username,
              password: url.password,
            },
          };
          break;
        default:
          // Default SQL Server authentication
          config.user = url.username;
          config.password = url.password;
          break;
      }

      return config;
    } catch (error) {
      throw new Error(
        `Failed to parse SQL Server DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "sqlserver://username:password@localhost:1433/database?sslmode=disable&instanceName=INSTANCE1";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith('sqlserver://');
    } catch (error) {
      return false;
    }
  }
}

/**
 * SQL Server connector
 */
export class SQLServerConnector implements Connector {
  id: ConnectorType = "sqlserver";
  name = "SQL Server";
  dsnParser = new SQLServerDSNParser();

  private connection?: sql.ConnectionPool;
  private config?: sql.config;
  // Source ID is set by ConnectorManager after cloning
  private sourceId: string = "default";

  /**
   * Leading whitespace and SQL comments to skip before looking for a keyword.
   * The read-only validator strips comments before checking the first keyword,
   * so the connector must skip them too; otherwise an EXPLAIN preceded by a
   * comment passes validation but reaches the server untranslated.
   */
  private static readonly LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

  /** Boolean spellings PostgreSQL accepts for an EXPLAIN option. */
  private static readonly EXPLAIN_ON = /^(?:true|on|1)$/i;
  private static readonly EXPLAIN_OFF = /^(?:false|off|0)$/i;

  /**
   * One option inside `EXPLAIN (...)`: a name, then optionally a value written
   * either space-separated as PostgreSQL spells it (`ANALYZE false`) or with an
   * equals sign, which the read-only classifier also accepts (`ANALYZE = 0`).
   */
  private static readonly EXPLAIN_OPTION = /^([A-Za-z_]+)(?:(?:\s*=\s*|\s+)(\S+))?$/;

  /** A disabling boolean directly after a bare `EXPLAIN ANALYZE`. */
  private static readonly EXPLAIN_BARE_DISABLED = /^(?:=\s*)?(?:false|off|0)\b/i;

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new SQLServerConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      this.config = await this.dsnParser.parse(dsn, config);

      if (!this.config.options) {
        this.config.options = {};
      }

      // Assign before connecting so a failed connect() leaves the pool reachable
      // for teardown below. connect() resolves to this same ConnectionPool.
      this.connection = new sql.ConnectionPool(this.config);
      await this.connection.connect();
    } catch (error) {
      // Tear down the pool if it was created before the failure, otherwise it
      // strands sockets and keeps the event loop alive (see closeQuietly).
      if (this.connection) {
        const connection = this.connection;
        this.connection = undefined;
        await closeQuietly(() => connection.close());
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = undefined;
    }
  }

  async getSchemas(): Promise<string[]> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    try {
      const result = await this.connection.request().query(`
          SELECT SCHEMA_NAME
          FROM INFORMATION_SCHEMA.SCHEMATA
          ORDER BY SCHEMA_NAME
      `);

      return result.recordset.map((row: { SCHEMA_NAME: any }) => row.SCHEMA_NAME);
    } catch (error) {
      throw new Error(`Failed to get schemas: ${(error as Error).message}`);
    }
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      // This is the default schema for SQL Server databases
      const schemaToUse = schema || "dbo";

      const request = this.connection.request().input("schema", sql.VarChar, schemaToUse);

      const query = `
          SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = @schema
          AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME
      `;

      const result = await request.query(query);

      return result.recordset.map((row: { TABLE_NAME: any }) => row.TABLE_NAME);
    } catch (error) {
      throw new Error(`Failed to get tables: ${(error as Error).message}`);
    }
  }

  async getViews(schema?: string): Promise<string[]> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    try {
      const schemaToUse = schema || "dbo";

      const request = this.connection.request().input("schema", sql.VarChar, schemaToUse);

      const query = `
          SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = @schema
          AND TABLE_TYPE = 'VIEW'
          ORDER BY TABLE_NAME
      `;

      const result = await request.query(query);

      return result.recordset.map((row: { TABLE_NAME: any }) => row.TABLE_NAME);
    } catch (error) {
      throw new Error(`Failed to get views: ${(error as Error).message}`);
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || "dbo";

      const request = this.connection
        .request()
        .input("tableName", sql.VarChar, tableName)
        .input("schema", sql.VarChar, schemaToUse);

      const query = `
          SELECT COUNT(*) as count
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_NAME = @tableName
            AND TABLE_SCHEMA = @schema
      `;

      const result = await request.query(query);

      return result.recordset[0].count > 0;
    } catch (error) {
      throw new Error(`Failed to check if table exists: ${(error as Error).message}`);
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || "dbo";

      const request = this.connection
        .request()
        .input("tableName", sql.VarChar, tableName)
        .input("schema", sql.VarChar, schemaToUse);

      // This gets all indexes including primary keys
      const query = `
          SELECT i.name AS index_name,
                 i.is_unique,
                 i.is_primary_key,
                 c.name AS column_name,
                 ic.key_ordinal
          FROM sys.indexes i
                   INNER JOIN
               sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                   INNER JOIN
               sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                   INNER JOIN
               sys.tables t ON i.object_id = t.object_id
                   INNER JOIN
               sys.schemas s ON t.schema_id = s.schema_id
          WHERE t.name = @tableName
            AND s.name = @schema
          ORDER BY i.name,
                   ic.key_ordinal
      `;

      const result = await request.query(query);

      // Group by index name to collect all columns for each index
      const indexMap = new Map<
        string,
        {
          columns: string[];
          is_unique: boolean;
          is_primary: boolean;
        }
      >();

      for (const row of result.recordset) {
        const indexName = row.index_name;
        const columnName = row.column_name;
        const isUnique = !!row.is_unique;
        const isPrimary = !!row.is_primary_key;

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

      // Convert Map to array of TableIndex objects
      const indexes: TableIndex[] = [];
      indexMap.forEach((info, name) => {
        indexes.push({
          index_name: name,
          column_names: info.columns,
          is_unique: info.is_unique,
          is_primary: info.is_primary,
        });
      });

      return indexes;
    } catch (error) {
      throw new Error(`Failed to get indexes for table ${tableName}: ${(error as Error).message}`);
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || "dbo";

      const request = this.connection
        .request()
        .input("tableName", sql.VarChar, tableName)
        .input("schema", sql.VarChar, schemaToUse);

      const query = `
          SELECT c.COLUMN_NAME as    column_name,
                 c.DATA_TYPE as      data_type,
                 c.IS_NULLABLE as    is_nullable,
                 c.COLUMN_DEFAULT as column_default,
                 ep.value as         description
          FROM INFORMATION_SCHEMA.COLUMNS c
          LEFT JOIN sys.columns sc
            ON sc.name = c.COLUMN_NAME
            AND sc.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME))
          LEFT JOIN sys.extended_properties ep
            ON ep.major_id = sc.object_id
            AND ep.minor_id = sc.column_id
            AND ep.name = 'MS_Description'
          WHERE c.TABLE_NAME = @tableName
            AND c.TABLE_SCHEMA = @schema
          ORDER BY c.ORDINAL_POSITION
      `;

      const result = await request.query(query);

      // Normalize empty string comments to null for token-efficient output
      return result.recordset.map((row: any) => ({
        ...row,
        description: row.description || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get schema for table ${tableName}: ${(error as Error).message}`);
    }
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    try {
      const schemaToUse = schema || "dbo";

      const request = this.connection
        .request()
        .input("tableName", sql.VarChar, tableName)
        .input("schema", sql.VarChar, schemaToUse);

      const query = `
          SELECT ep.value as table_comment
          FROM sys.extended_properties ep
          JOIN sys.tables t ON ep.major_id = t.object_id
          JOIN sys.schemas s ON t.schema_id = s.schema_id
          WHERE ep.minor_id = 0
            AND ep.name = 'MS_Description'
            AND t.name = @tableName
            AND s.name = @schema
      `;

      const result = await request.query(query);

      if (result.recordset.length > 0) {
        return result.recordset[0].table_comment || null;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  async getStoredProcedures(schema?: string, routineType?: "procedure" | "function"): Promise<string[]> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || "dbo";

      const request = this.connection.request().input("schema", sql.VarChar, schemaToUse);

      // Build routine type filter
      let typeFilter: string;
      if (routineType === "function") {
        typeFilter = "AND ROUTINE_TYPE = 'FUNCTION'";
      } else if (routineType === "procedure") {
        typeFilter = "AND ROUTINE_TYPE = 'PROCEDURE'";
      } else {
        typeFilter = "AND (ROUTINE_TYPE = 'PROCEDURE' OR ROUTINE_TYPE = 'FUNCTION')";
      }

      const query = `
          SELECT ROUTINE_NAME
          FROM INFORMATION_SCHEMA.ROUTINES
          WHERE ROUTINE_SCHEMA = @schema
            ${typeFilter}
          ORDER BY ROUTINE_NAME
      `;

      const result = await request.query(query);
      return result.recordset.map((row: { ROUTINE_NAME: any }) => row.ROUTINE_NAME);
    } catch (error) {
      throw new Error(`Failed to get stored procedures: ${(error as Error).message}`);
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || "dbo";

      const request = this.connection
        .request()
        .input("procedureName", sql.VarChar, procedureName)
        .input("schema", sql.VarChar, schemaToUse);

      // First, get basic procedure information
      const routineQuery = `
          SELECT ROUTINE_NAME as procedure_name,
                 ROUTINE_TYPE,
                 DATA_TYPE    as return_data_type
          FROM INFORMATION_SCHEMA.ROUTINES
          WHERE ROUTINE_NAME = @procedureName
            AND ROUTINE_SCHEMA = @schema
      `;

      const routineResult = await request.query(routineQuery);

      if (routineResult.recordset.length === 0) {
        throw new Error(`Stored procedure '${procedureName}' not found in schema '${schemaToUse}'`);
      }

      const routine = routineResult.recordset[0];

      // Next, get parameter information
      const parameterQuery = `
          SELECT PARAMETER_NAME,
                 PARAMETER_MODE,
                 DATA_TYPE,
                 CHARACTER_MAXIMUM_LENGTH,
                 ORDINAL_POSITION
          FROM INFORMATION_SCHEMA.PARAMETERS
          WHERE SPECIFIC_NAME = @procedureName
            AND SPECIFIC_SCHEMA = @schema
          ORDER BY ORDINAL_POSITION
      `;

      const parameterResult = await request.query(parameterQuery);

      // Format the parameter list
      let parameterList = "";
      if (parameterResult.recordset.length > 0) {
        parameterList = parameterResult.recordset
          .map(
            (param: {
              CHARACTER_MAXIMUM_LENGTH: number;
              PARAMETER_NAME: any;
              PARAMETER_MODE: any;
              DATA_TYPE: any;
            }) => {
              const lengthStr =
                param.CHARACTER_MAXIMUM_LENGTH > 0 ? `(${param.CHARACTER_MAXIMUM_LENGTH})` : "";
              return `${param.PARAMETER_NAME} ${param.PARAMETER_MODE} ${param.DATA_TYPE}${lengthStr}`;
            }
          )
          .join(", ");
      }

      // Get the procedure definition from sys.sql_modules
      const definitionQuery = `
          SELECT definition
          FROM sys.sql_modules sm
                   JOIN sys.objects o ON sm.object_id = o.object_id
                   JOIN sys.schemas s ON o.schema_id = s.schema_id
          WHERE o.name = @procedureName
            AND s.name = @schema
      `;

      const definitionResult = await request.query(definitionQuery);
      let definition = undefined;

      if (definitionResult.recordset.length > 0) {
        definition = definitionResult.recordset[0].definition;
      }

      return {
        procedure_name: routine.procedure_name,
        procedure_type: routine.ROUTINE_TYPE === "PROCEDURE" ? "procedure" : "function",
        language: "sql", // SQL Server procedures are typically in T-SQL
        parameter_list: parameterList,
        return_type: routine.ROUTINE_TYPE === "FUNCTION" ? routine.return_data_type : undefined,
        definition: definition,
      };
    } catch (error) {
      throw new Error(`Failed to get stored procedure details: ${(error as Error).message}`);
    }
  }

  async executeSQL(sqlQuery: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    // SQL Server has no native EXPLAIN statement. Translate a leading `EXPLAIN`
    // into a SHOWPLAN_XML request so callers get a Postgres/MySQL-like
    // experience. SHOWPLAN_XML compiles the statement without executing it, so
    // this is read-only safe (further enforced in explainQuery).
    //
    // `EXPLAIN ANALYZE` keeps Postgres semantics: the statement really runs and
    // the plan carries actual row counts. SHOWPLAN_XML cannot report those, so
    // that form maps to SET STATISTICS XML instead (see explainAnalyzeQuery).
    const afterNoise = sqlQuery.slice(
      sqlQuery.match(SQLServerConnector.LEADING_NOISE)![0].length
    );
    if (/^explain\b/i.test(afterNoise)) {
      const { analyze, query } = SQLServerConnector.parseExplainPrefix(
        afterNoise.slice("explain".length).trim()
      );
      return analyze
        ? this.explainAnalyzeQuery(query, options, parameters)
        : this.explainQuery(query, options.readonly, parameters);
    }

    try {
      // Apply maxRows limit to SELECT queries if specified
      let processedSQL = sqlQuery;
      if (options.maxRows) {
        processedSQL = SQLRowLimiter.applyMaxRowsForSQLServer(sqlQuery, options.maxRows);
      }

      // Engine-level read-only enforcement: SQL Server has no
      // BEGIN TRANSACTION READ ONLY, so we wrap in a transaction and
      // unconditionally ROLLBACK to prevent any modifications from persisting.
      // This is defense-in-depth behind the keyword classifier.
      if (options.readonly) {
        return await this.executeReadOnly(processedSQL, parameters);
      }

      // Create request and collect informational messages (e.g. SET STATISTICS TIME/IO, PRINT)
      const request = this.connection.request();
      const messages: DatabaseMessage[] = [];
      request.on(
        'info',
        (info: { message: string; number?: number; class?: number; lineNumber?: number }) => {
          messages.push({
            text: info.message,
            // SQL Server reports severity as a numeric class; info messages are < 10.
            severity: info.class !== undefined ? String(info.class) : undefined,
            code: info.number,
            line: info.lineNumber,
          });
        }
      );

      SQLServerConnector.bindParameters(request, parameters);

      let result;
      try {
        result = await request.query(processedSQL);
      } catch (error) {
        if (parameters && parameters.length > 0) {
          console.error(`[SQL Server executeSQL] ERROR: ${(error as Error).message}`);
          console.error(`[SQL Server executeSQL] SQL: ${processedSQL}`);
          console.error(`[SQL Server executeSQL] Parameters: ${JSON.stringify(parameters)}`);
        }
        throw error;
      }

      return {
        rows: result.recordset || [],
        rowCount: result.rowsAffected[0] || 0,
        ...(messages.length > 0 ? { messages } : {}),
      };
    } catch (error) {
      throw new Error(`Failed to execute query: ${(error as Error).message}`);
    }
  }

  /**
   * Bind positional parameters as @p1, @p2, ... inferring the SQL Server type
   * from each JavaScript value. Shared by every execution path so they cannot
   * drift in how a given value is typed.
   *
   * Works for `batch` as well as `query`: node-mssql prepends the matching
   * DECLARE/SET statements when the request is a batch.
   */
  private static bindParameters(request: sql.Request, parameters?: any[]): void {
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
  private assertNoReadOnlyEscapes(
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

  /**
   * Execute a query inside a transaction that always rolls back, preventing
   * any modifications from persisting. SQL Server has no native READ ONLY
   * transaction mode, so this is the defense-in-depth backstop behind the
   * keyword classifier.
   *
   * Dangerous constructs are rejected before the transaction opens; see
   * assertNoReadOnlyEscapes.
   */
  private async executeReadOnly(
    processedSQL: string,
    parameters?: any[],
  ): Promise<SQLResult> {
    this.assertNoReadOnlyEscapes(processedSQL, { transactionControl: true });

    const transaction = new sql.Transaction(this.connection!);
    await transaction.begin();

    const request = new sql.Request(transaction);
    const messages: DatabaseMessage[] = [];
    request.on(
      'info',
      (info: { message: string; number?: number; class?: number; lineNumber?: number }) => {
        messages.push({
          text: info.message,
          severity: info.class !== undefined ? String(info.class) : undefined,
          code: info.number,
          line: info.lineNumber,
        });
      },
    );

    SQLServerConnector.bindParameters(request, parameters);

    let result;
    let queryFailed = false;
    try {
      result = await request.query(processedSQL);
    } catch (error) {
      queryFailed = true;
      console.error(`[SQL Server executeReadOnly] ERROR: ${(error as Error).message}`);
      console.error(`[SQL Server executeReadOnly] SQL: ${processedSQL}`);
      if (parameters && parameters.length > 0) {
        console.error(`[SQL Server executeReadOnly] Parameters: ${JSON.stringify(parameters)}`);
      }
      throw error;
    } finally {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        if (!queryFailed) {
          throw new Error(
            `Read-only rollback failed — data may have been modified: ${(rollbackError as Error).message}`,
          );
        }
      }
    }
    return {
      rows: result.recordset || [],
      rowCount: result.rowsAffected[0] || 0,
      ...(messages.length > 0 ? { messages } : {}),
    };
  }

  /**
   * Return the estimated execution plan for a query using SHOWPLAN_XML.
   *
   * SHOWPLAN_XML compiles the statement and returns its plan without executing
   * it, but it has two constraints: `SET SHOWPLAN_XML ON` must be the only
   * statement in its batch, and the setting is session scoped. The shared pool
   * hands out a fresh connection per request() and an open transaction
   * suppresses SHOWPLAN, so neither can carry the setting to a follow-up query.
   *
   * We therefore run the SET / query pair on a short-lived, single-connection
   * pool built from the same config. The dedicated session keeps SHOWPLAN state
   * off the shared pool, so a concurrent query can never land on a connection
   * with SHOWPLAN enabled (which would return a plan instead of its results).
   */
  private async explainQuery(
    innerQuery: string,
    readonly?: boolean,
    parameters?: any[]
  ): Promise<SQLResult> {
    // Validate against comment/string-stripped SQL so comment-only input counts
    // as empty and a SET SHOWPLAN can't hide behind comments.
    const cleaned = stripCommentsAndStrings(innerQuery, "sqlserver").trim();
    if (!cleaned) {
      throw new Error("EXPLAIN requires a statement to analyze");
    }

    // EXPLAIN is routed here before the read-only branch in executeSQL, so it
    // opens no rolling-back transaction. SHOWPLAN_XML compiles without
    // executing, but that single session toggle would otherwise be the whole
    // guarantee — apply the same escape checks as executeReadOnly. Skipped
    // outside read-only mode, where explaining an EXEC is legitimate.
    if (readonly) {
      this.assertNoReadOnlyEscapes(innerQuery);
    }

    // Defense in depth: the SET SHOWPLAN session toggle is what makes EXPLAIN
    // non-executing, so the explained statement must not disable it. SQL Server
    // already rejects `SET SHOWPLAN_* OFF` alongside other statements in a
    // batch, but enforcing it here keeps the read-only guarantee self-contained.
    if (/\bset\s+showplan/i.test(cleaned)) {
      throw new Error("EXPLAIN does not support SET SHOWPLAN statements");
    }

    if (!this.config) {
      throw new Error("Not connected to SQL Server database");
    }

    const explainPool = new sql.ConnectionPool({
      ...this.config,
      pool: { ...this.config.pool, max: 1, min: 1 },
    });

    try {
      await explainPool.connect();
      // max:1 + sequential awaits guarantee both batches hit the same session.
      await explainPool.request().batch("SET SHOWPLAN_XML ON");

      // The parameters belong on the statement being explained, not on the
      // toggle. node-mssql turns them into DECLARE/SET, which SHOWPLAN compiles
      // without executing — so the plan is the one for a parameterized query,
      // estimated from density rather than from the literal values.
      const planRequest = explainPool.request();
      SQLServerConnector.bindParameters(planRequest, parameters);
      const planResult = await planRequest.batch(innerQuery);

      // The plan is returned as the single column of the first row.
      const planRow = planResult.recordset?.[0];
      const planXml = planRow ? Object.values(planRow)[0] : null;
      return {
        rows: planXml != null ? [{ plan: planXml }] : [],
        rowCount: planXml != null ? 1 : 0,
      };
    } catch (error) {
      throw new Error(`Failed to explain query: ${(error as Error).message}`);
    } finally {
      await explainPool.close();
    }
  }

  /**
   * Splits the modifiers between EXPLAIN and its statement, covering the same
   * forms the read-only classifier recognises (see utils/allowed-keywords.ts):
   * `ANALYZE`, `ANALYZE VERBOSE`, `(ANALYZE)`, `(ANALYZE, BUFFERS)`,
   * `(ANALYZE false)`.
   *
   * Only ANALYZE carries a meaning here — it selects STATISTICS XML over
   * SHOWPLAN_XML. The rest are PostgreSQL planner knobs with no SQL Server
   * counterpart, so they are refused by name: silently dropping an option would
   * quietly hand back something other than what was asked for.
   */
  private static parseExplainPrefix(afterExplain: string): { analyze: boolean; query: string } {
    // Parenthesized list: (ANALYZE, ...) <statement>
    if (afterExplain.startsWith("(")) {
      const close = afterExplain.indexOf(")");
      if (close < 0) {
        throw new Error("EXPLAIN option list is missing its closing ')'");
      }

      let analyze = false;
      for (const part of afterExplain.slice(1, close).split(",")) {
        const token = part.trim();
        if (!token) continue;

        const parsed = SQLServerConnector.EXPLAIN_OPTION.exec(token);
        if (!parsed) {
          throw new Error(
            `EXPLAIN option '${token}' is not supported on SQL Server — only ANALYZE is.`
          );
        }

        const name = parsed[1];
        if (!/^analyze$/i.test(name)) {
          throw new Error(
            `EXPLAIN option '${name}' is not supported on SQL Server — only ANALYZE is.`
          );
        }

        const value = parsed[2];
        if (value === undefined || SQLServerConnector.EXPLAIN_ON.test(value)) {
          analyze = true;
        } else if (SQLServerConnector.EXPLAIN_OFF.test(value)) {
          analyze = false;
        } else {
          throw new Error(`EXPLAIN option 'ANALYZE' expects a boolean, got '${value}'.`);
        }
      }

      return { analyze, query: afterExplain.slice(close + 1).trim() };
    }

    // Bare form: [ANALYZE [VERBOSE]] <statement>
    const analyzeKeyword = /^analyze\b/i.exec(afterExplain);
    if (!analyzeKeyword) {
      return { analyze: false, query: afterExplain };
    }

    const rest = afterExplain.slice(analyzeKeyword[0].length).trim();

    // PostgreSQL only takes a boolean in the parenthesized form, but the
    // read-only classifier reads a disabling value here too — `ANALYZE false`,
    // `ANALYZE = 0` — as a plain EXPLAIN. Left unhandled, the two layers
    // disagree in the dangerous direction: the classifier waives the DML check
    // for what it believes is a non-executing statement, while this path routes
    // to the one that executes.
    const disabled = SQLServerConnector.EXPLAIN_BARE_DISABLED.exec(rest);
    if (disabled) {
      return { analyze: false, query: rest.slice(disabled[0].length).trim() };
    }

    const trailing = /^([A-Za-z_]+)\b/.exec(rest);
    if (trailing && /^verbose$/i.test(trailing[1])) {
      throw new Error(
        "EXPLAIN option 'VERBOSE' is not supported on SQL Server — only ANALYZE is."
      );
    }

    return { analyze: true, query: rest };
  }

  /**
   * Run a statement under SET STATISTICS XML and return its *actual* execution
   * plan — the Postgres `EXPLAIN ANALYZE` contract.
   *
   * SHOWPLAN_XML (plain EXPLAIN) compiles without executing, so its plan carries
   * only estimates. STATISTICS XML runs the statement, so the plan reports real
   * row counts and execution counts. The flip side is that this path is *not*
   * inherently read-only the way explainQuery is, so under `options.readonly` the
   * statement runs inside a transaction that always rolls back.
   *
   * The dedicated single-connection pool serves the same purpose as in
   * explainQuery: the STATISTICS XML session toggle must never leak onto a
   * shared pool connection, where a concurrent query would inherit it.
   */
  private async explainAnalyzeQuery(
    innerQuery: string,
    options: ExecuteOptions,
    parameters?: any[]
  ): Promise<SQLResult> {
    // Validate against comment/string-stripped SQL so comment-only input counts
    // as empty and a SET STATISTICS can't hide behind comments.
    const cleaned = stripCommentsAndStrings(innerQuery, "sqlserver").trim();
    if (!cleaned) {
      throw new Error("EXPLAIN ANALYZE requires a statement to analyze");
    }

    // Defense in depth: the SET STATISTICS XML toggle is what yields the plan,
    // so the analyzed statement must not disable it or swap in SHOWPLAN — the
    // latter would suppress execution, and the actual counts with it.
    if (/\bset\s+statistics\b/i.test(cleaned)) {
      throw new Error("EXPLAIN ANALYZE does not support SET STATISTICS statements");
    }
    if (/\bset\s+showplan\b/i.test(cleaned)) {
      throw new Error("EXPLAIN ANALYZE does not support SET SHOWPLAN statements");
    }

    // Unlike plain EXPLAIN, this path executes, and its only read-only guard is
    // the application-level rollback below — so the escapes matter more here,
    // not less. transactionControl is set because that rollback is a real
    // transaction a COMMIT could close, which is not true of explainQuery.
    if (options.readonly) {
      this.assertNoReadOnlyEscapes(innerQuery, { transactionControl: true });
    }

    if (!this.config) {
      throw new Error("Not connected to SQL Server database");
    }

    const explainPool = new sql.ConnectionPool({
      ...this.config,
      pool: { ...this.config.pool, max: 1, min: 1 },
    });

    try {
      await explainPool.connect();
      // max:1 + sequential awaits guarantee every batch hits the same session.
      await explainPool.request().batch("SET STATISTICS XML ON");

      let planResult: sql.IResult<any>;
      if (options.readonly) {
        planResult = await SQLServerConnector.batchRolledBack(
          explainPool,
          innerQuery,
          parameters
        );
      } else {
        const planRequest = explainPool.request();
        SQLServerConnector.bindParameters(planRequest, parameters);
        planResult = await planRequest.batch(innerQuery);
      }

      const planXml = SQLServerConnector.extractPlanXml(planResult);
      return {
        rows: planXml != null ? [{ plan: planXml }] : [],
        rowCount: planXml != null ? 1 : 0,
      };
    } catch (error) {
      // Named apart from the plain EXPLAIN path: this one ran the statement, so
      // a failure here can mean the statement itself failed mid-execution.
      throw new Error(`Failed to explain analyze query: ${(error as Error).message}`);
    } finally {
      await explainPool.close();
    }
  }

  /**
   * Run a batch inside a transaction that is always rolled back, so EXPLAIN
   * ANALYZE can report a real plan without letting the statement's writes stick.
   */
  private static async batchRolledBack(
    pool: sql.ConnectionPool,
    innerQuery: string,
    parameters?: any[]
  ): Promise<sql.IResult<any>> {
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    let queryFailed = false;
    try {
      const request = new sql.Request(transaction);
      SQLServerConnector.bindParameters(request, parameters);
      return await request.batch(innerQuery);
    } catch (error) {
      queryFailed = true;
      throw error;
    } finally {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        // A failed query already aborted the transaction, so a rollback error
        // there is expected noise. After a *successful* query it means the
        // writes may still be live — that must surface.
        if (!queryFailed) {
          throw new Error(
            `Read-only rollback failed — data may have been modified: ${(rollbackError as Error).message}`
          );
        }
      }
    }
  }

  /**
   * Pull the ShowPlanXML document out of a STATISTICS XML result.
   *
   * STATISTICS XML interleaves each statement's plan with that statement's own
   * result sets, so the plan sits at no fixed index — and `recordset` (singular)
   * would hand back the statement's data instead. Scan from the end for the
   * first single-column row holding a plan document.
   */
  private static extractPlanXml(result: sql.IResult<any>): string | null {
    const recordsets = (result.recordsets ?? []) as unknown as any[][];

    for (let i = recordsets.length - 1; i >= 0; i--) {
      const firstRow = recordsets[i]?.[0];
      if (!firstRow) continue;

      const values = Object.values(firstRow);
      if (values.length !== 1) continue;

      const value = values[0];
      if (typeof value === "string" && value.includes("<ShowPlanXML")) {
        return value;
      }
    }

    return null;
  }
}

// Create and register the connector
const sqlServerConnector = new SQLServerConnector();
ConnectorRegistry.register(sqlServerConnector);
