import sql from "mssql";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  SQLResultSet,
  DatabaseMessage,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
  HealthCheckResult,
} from "../interface.js";
import { computeHitRatioPct, toNullableNumber } from "../health-check-utils.js";
import { isDriverNotInstalled } from "../../utils/module-loader.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { LEADING_SQL_NOISE, splitSQLStatements, stripCommentsAndStrings } from "../../utils/sql-parser.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";
import { assertNoReadOnlyEscapes, bindParameters } from "./request-helpers.js";
import { explainAnalyzeQuery, explainQuery, parseExplainPrefix } from "./explain.js";

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
      // Inspect the same raw query as SafeURL before it drops empty/malformed
      // pairs or collapses duplicates. Decode query keys as well as values.
      const queryStart = dsn.indexOf("?");
      const sslmodes = new URLSearchParams(queryStart === -1 ? "" : dsn.substring(queryStart + 1)).getAll("sslmode");
      if (sslmodes.length > 1 || (sslmodes.length === 1 && !["disable", "require", "verify-full"].includes(sslmodes[0]))) {
        throw new Error("Invalid sslmode. Specify exactly one value: disable, require, verify-full");
      }

      // Use the SafeURL helper to parse DSNs with special characters
      const url = new SafeURL(dsn);
      
      // Parse additional options from query parameters
      const options: Record<string, any> = { sslmode: sslmodes[0] };
      
      // Process query parameters
      url.forEachSearchParam((value, key) => {
        if (key === "authentication") {
          options.authentication = value;
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
        } else if (options.sslmode === "verify-full") {
          options.encrypt = true;
          options.trustServerCertificate = false;
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

  async getHealthCheck(): Promise<HealthCheckResult> {
    if (!this.connection) {
      throw new Error("Not connected to SQL Server database");
    }

    const notes: string[] = [];
    const result: HealthCheckResult = {};

    // sys.dm_exec_sessions/sys.dm_exec_requests require the VIEW SERVER STATE
    // permission (VIEW DATABASE STATE on Azure SQL Database) to see anything
    // beyond the querying session itself, and can outright deny access
    // depending on edition/permissions. Degrade instead of failing the whole
    // health check.
    try {
      const [connResult, maxConnResult] = await Promise.all([
        this.connection.request().query(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN r.session_id IS NOT NULL THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END) AS idle,
            SUM(CASE WHEN r.session_id IS NULL AND t.session_id IS NOT NULL THEN 1 ELSE 0 END) AS idle_in_transaction,
            MAX(CASE WHEN r.session_id IS NULL AND t.session_id IS NOT NULL
                  THEN DATEDIFF(SECOND, s.last_request_end_time, SYSDATETIME()) ELSE NULL END) AS longest_idle_in_transaction_seconds,
            MAX(CASE WHEN r.session_id IS NOT NULL
                  THEN DATEDIFF(SECOND, r.start_time, SYSDATETIME()) ELSE NULL END) AS longest_active_query_seconds
          FROM sys.dm_exec_sessions s
          LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
          LEFT JOIN (SELECT DISTINCT session_id FROM sys.dm_tran_session_transactions) t ON t.session_id = s.session_id
          WHERE s.is_user_process = 1 AND s.session_id <> @@SPID
        `),
        this.connection.request().query(`
          SELECT CAST(value_in_use AS INT) AS max_connections
          FROM sys.configurations
          WHERE name = 'user connections'
        `),
      ]);
      const conn = connResult.recordset[0];
      // 0 means "auto-configured, no fixed limit" rather than an actual cap.
      const maxConnections =
        maxConnResult.recordset.length > 0 && maxConnResult.recordset[0].max_connections > 0
          ? maxConnResult.recordset[0].max_connections
          : null;

      result.connections = {
        total: conn.total ?? 0,
        active: conn.active ?? 0,
        idle: conn.idle ?? 0,
        idleInTransaction: conn.idle_in_transaction ?? 0,
        // SQL Server has no equivalent of Postgres's "idle in transaction
        // (aborted)" state - a failed statement doesn't leave the session's
        // transaction in a distinct aborted-but-open state the way Postgres does.
        maxConnections,
        longestIdleInTransactionSeconds: toNullableNumber(conn.longest_idle_in_transaction_seconds),
        longestActiveQuerySeconds: toNullableNumber(conn.longest_active_query_seconds),
      };
    } catch {
      notes.push(
        "Connection pool metrics unavailable: connecting user lacks the VIEW SERVER STATE permission (VIEW DATABASE STATE on Azure SQL Database)."
      );
    }

    try {
      const bufferResult = await this.connection.request().query(`
        SELECT counter_name, CAST(cntr_value AS BIGINT) AS cntr_value
        FROM sys.dm_os_performance_counters
        WHERE object_name LIKE '%Buffer Manager%'
          AND counter_name IN ('Page lookups/sec', 'Page reads/sec')
      `);
      const counters = Object.fromEntries(
        bufferResult.recordset.map((row: any) => [row.counter_name.trim(), Number(row.cntr_value)])
      );
      const pageLookups = counters["Page lookups/sec"] ?? 0;
      const pageReads = counters["Page reads/sec"] ?? 0;

      result.bufferCache = {
        hitRatioPct: computeHitRatioPct(pageLookups, pageReads),
        blocksHit: pageLookups - pageReads,
        blocksRead: pageReads,
      };
    } catch {
      notes.push(
        "Buffer cache metrics unavailable: connecting user lacks the VIEW SERVER STATE permission (VIEW DATABASE STATE on Azure SQL Database)."
      );
    }

    if (notes.length > 0) {
      result.notes = notes;
    }

    return result;
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
    if (!this.connection || !this.config) {
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
    const afterNoise = sqlQuery.replace(LEADING_SQL_NOISE, "");
    if (/^explain\b/i.test(afterNoise)) {
      const { analyze, query } = parseExplainPrefix(
        afterNoise.slice("explain".length).trim()
      );
      return analyze
        ? explainAnalyzeQuery(this.config, query, options, parameters)
        : explainQuery(this.config, query, options.readonly, parameters);
    }

    try {
      // Computed once and threaded into buildResultSets below (directly, or via
      // executeReadOnly) rather than re-derived from SQL text on every call.
      const statements = splitSQLStatements(sqlQuery, "sqlserver");
      const isSingleStatement = statements.length === 1;

      // Apply maxRows limit (with a truncation probe row) to every row-returning
      // statement of the batch, so a SELECT after the leading statement is capped
      // too. A single statement is rewritten in place so its text (trailing
      // semicolon, surrounding whitespace) reaches the server as written.
      // The splitter drops the batch's final semicolon, which a trailing MERGE
      // requires, so it is put back when the source had one.
      let processedSQL = sqlQuery;
      if (options.maxRows) {
        const maxRows = options.maxRows;
        if (isSingleStatement) {
          processedSQL = SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(sqlQuery, maxRows).sql;
        } else {
          // Reconstructed semicolons go on their own line: the splitter trims
          // each segment, so one that ends in a `--` line comment would
          // otherwise swallow a semicolon placed on the same line.
          const terminator = sqlQuery.trimEnd().endsWith(";") ? "\n;" : "";
          // The splitter cannot tell a batch statement from a semicolon-
          // terminated statement inside a module body (T-SQL has no body
          // quoting), and a CREATE/ALTER PROCEDURE/FUNCTION/TRIGGER body runs
          // to the end of the batch. Rewriting from there on would bake TOP
          // into the stored definition, so segments from the first module
          // definition onward are sent as written.
          const moduleStart = statements.findIndex((statement) =>
            SQLServerConnector.MODULE_DEFINITION.test(stripCommentsAndStrings(statement, "sqlserver"))
          );
          const rewritable = moduleStart === -1 ? statements.length : moduleStart;
          processedSQL =
            statements
              .map((statement, i) =>
                i < rewritable
                  ? SQLRowLimiter.applyMaxRowsForSQLServerWithTruncationProbe(statement, maxRows).sql
                  : statement
              )
              .join("\n;\n") + terminator;
        }
      }

      // Engine-level read-only enforcement: SQL Server has no
      // BEGIN TRANSACTION READ ONLY, so we wrap in a transaction and
      // unconditionally ROLLBACK to prevent any modifications from persisting.
      // This is defense-in-depth behind the keyword classifier.
      if (options.readonly) {
        return await this.executeReadOnly(
          processedSQL,
          parameters,
          isSingleStatement ? sqlQuery : undefined,
          options.maxRows,
        );
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

      bindParameters(request, parameters);

      const result = await request.query(processedSQL);

      const resultSets = SQLServerConnector.buildResultSets(
        result.recordsets,
        result.rowsAffected,
        isSingleStatement ? sqlQuery : undefined,
        options.maxRows,
      );
      return {
        resultSets,
        ...(messages.length > 0 ? { messages } : {}),
      };
    } catch (error) {
      throw new Error(`Failed to execute query: ${(error as Error).message}`);
    }
  }

  /**
   * Builds one result set per SELECT-producing statement in the batch, plus
   * (if any) a trailing result set summarizing the write-only statements.
   *
   * node-mssql only pushes a `recordsets` entry for statements that produce
   * columns (SELECT); INSERT/UPDATE/DELETE statements in the same batch
   * contribute to `rowsAffected` only, with no way to recover which
   * `rowsAffected` entry belongs to which statement from the driver's final
   * arrays (`recordsets`/`rowsAffected` aren't index-aligned - see the
   * tedious `doneHandler`, which always pushes to `rowsAffected` but only
   * conditionally to `recordsets`). So a batch of pure writes collapses to a
   * single summed result set, and a batch mixing writes with selects gets
   * one result set per select plus one trailing "writes" set for the rest -
   * not a truly per-statement breakdown, but no read statement's rows are
   * ever merged with another's, which is what mattered for #380.
   *
   * `sourceSql`, when given, is attributed to the single resulting set - it
   * must be omitted (pass `undefined`) unless the caller has already
   * confirmed the batch is unambiguously one statement, since for a genuine
   * multi-statement batch there's no reliable way to say which source
   * statement a given recordset (or the trailing writes set) came from.
   */
  /** A segment that opens a module whose body extends to the end of the batch. */
  private static readonly MODULE_DEFINITION =
    /^\s*(?:create|alter)\s+(?:or\s+alter\s+)?(?:proc|procedure|function|trigger)\b/i;

  /**
   * Builds one result set per recordset. With `maxRows`, every set is capped:
   * a statement the TOP/FETCH probe rewrite reached returns at most
   * maxRows + 1 rows, and more than maxRows rows means the cap fired, so the
   * probe row is dropped and the set flagged truncated. The same check also
   * bounds result sets the rewrite could not reach (a stored procedure's
   * output, say): those are trimmed to maxRows and flagged the same way. A
   * statement whose own TOP/FETCH is within the cap never exceeds maxRows
   * rows, so it is never flagged. Recordsets do not map 1:1 onto statements
   * (a SELECT ... INTO returns none, an EXEC may return several), which is
   * why the check is per result set rather than per rewritten statement.
   */
  private static buildResultSets(
    recordsets: any,
    rowsAffected: number[] | undefined,
    sourceSql: string | undefined,
    maxRows?: number,
  ): SQLResultSet[] {
    const sets: SQLResultSet[] = (recordsets ?? []).map((recordset: any) => {
      const rows = recordset ?? [];
      return { rows, rowCount: rows.length };
    });

    // Rows the SELECTs returned are counted before any probe row is dropped
    // below: rowsAffected counts that row too, so trimming first would make it
    // look like a write and append a spurious empty result set.
    const totalAffected = (rowsAffected ?? []).reduce((total, count) => total + (count ?? 0), 0);
    const accountedFor = sets.reduce((total, set) => total + set.rowCount, 0);
    const writesOnly = totalAffected - accountedFor;

    for (const set of sets) {
      SQLRowLimiter.flagTruncation(set, maxRows, true);
    }

    if (sets.length === 0) {
      sets.push({ rows: [], rowCount: totalAffected });
    } else if (writesOnly > 0) {
      sets.push({ rows: [], rowCount: writesOnly });
    }

    // A pure-writes batch collapses to one synthetic set above regardless of
    // how many write statements it actually had, so sourceSql being given is
    // not on its own proof of a single statement - the caller's
    // isSingleStatement check (done once, from the real source text) is.
    if (sets.length === 1 && sourceSql !== undefined) {
      sets[0].sql = sourceSql;
    }
    return sets;
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
    parameters: any[] | undefined,
    // Original (pre-rewrite) statement text for attribution; undefined for
    // multi-statement batches, where attribution would be a guess.
    sourceSql: string | undefined,
    maxRows: number | undefined,
  ): Promise<SQLResult> {
    assertNoReadOnlyEscapes(processedSQL, { transactionControl: true });

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

    bindParameters(request, parameters);

    let result;
    let queryFailed = false;
    try {
      result = await request.query(processedSQL);
    } catch (error) {
      queryFailed = true;
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
    const resultSets = SQLServerConnector.buildResultSets(
      result.recordsets,
      result.rowsAffected,
      sourceSql,
      maxRows,
    );
    return {
      resultSets,
      ...(messages.length > 0 ? { messages } : {}),
    };
  }

}

// Create and register the connector
const sqlServerConnector = new SQLServerConnector();
ConnectorRegistry.register(sqlServerConnector);
