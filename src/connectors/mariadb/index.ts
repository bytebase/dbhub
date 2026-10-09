import * as mariadb from "mariadb";
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
  HealthCheckResult,
} from "../interface.js";
import { getMySQLFamilyHealthCheck } from "../mysql-family-health-check.js";
import * as introspection from "../mysql-family-introspection.js";
import type { MySQLFamilyQuery } from "../mysql-family-introspection.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { requireDatabaseInDSN, MissingDatabaseError } from "../../utils/dsn-database.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { parseQueryResultSets } from "../../utils/multi-statement-result-parser.js";
import { splitSQLStatements } from "../../utils/sql-parser.js";
import { withReadOnlyTransaction } from "../../utils/readonly-transaction.js";
import {
  clientQueryTimeoutMs,
  isClientSideTimeout,
  withClientQueryDeadline,
} from "../../utils/query-timeout.js";
import { isTiDBVersion } from "../../utils/server-flavor.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";

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

      const database = url.pathname ? url.pathname.substring(1) : ''; // Remove leading '/' if exists
      requireDatabaseInDSN(database, dsn, "MariaDB");

      const connectionConfig: mariadb.ConnectionConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 3306,
        database,
        user: url.username,
        password: url.password,
        multipleStatements: true, // Enable native multi-statement support
        ...(connectionTimeoutSeconds !== undefined && {
          connectTimeout: connectionTimeoutSeconds * 1000
        }),
        // Server-side limit: the driver applies `queryTimeout` on each new
        // connection as the session variable max_statement_time.
        ...(queryTimeoutSeconds !== undefined && {
          queryTimeout: queryTimeoutSeconds * 1000
        }),
        // Controls how the driver interprets DATETIME values ("Z", "local", or "±HH:MM").
        ...(config?.timezone !== undefined && {
          timezone: config.timezone
        }),
        // Connection character set (e.g. "utf8mb4") / collation (e.g.
        // "utf8mb4_general_ci"). The mariadb driver exposes both as distinct
        // options, but a configured collation is authoritative (it implies its
        // character set) and the driver ignores `collation` when `charset` is also
        // passed. So forward the collation when present, otherwise the charset
        // (which uses that character set's default collation).
        ...(config?.collation !== undefined
          ? { collation: config.collation }
          : config?.charset !== undefined
            ? { charset: config.charset }
            : {}),
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
      // Surface the actionable missing-database message as-is
      if (error instanceof MissingDatabaseError) {
        throw error;
      }
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
  // Client-side fallback deadline; the mariadb driver has no client-side
  // timer of its own (see query-timeout.ts).
  private clientQueryTimeoutMs?: number;
  // TiDB speaks the MySQL protocol but rejects `START TRANSACTION READ ONLY`
  // unless tidb_enable_noop_functions is on. Detected once at connect time.
  private supportsReadOnlyTransaction: boolean = true;

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new MariaDBConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const connectionConfig = await this.dsnParser.parse(dsn, config);
      this.clientQueryTimeoutMs =
        config?.queryTimeoutSeconds !== undefined
          ? clientQueryTimeoutMs(config.queryTimeoutSeconds * 1000)
          : undefined;

      this.pool = mariadb.createPool(connectionConfig);

      // The mariadb pool keeps `minimumIdle` connections open in the background
      // (defaults to connectionLimit) and emits an 'error' event on the pool when
      // one of those background reconnect attempts fails, e.g. while the server
      // is restarting. Without a listener Node treats it as unhandled and exits
      // the whole process. The pool retries with backoff on its own, so logging
      // is all that is needed here. The typings omit this event, but the runtime
      // Pool is an EventEmitter.
      (this.pool as unknown as NodeJS.EventEmitter).on("error", (err: Error) => {
        console.error(
          `MariaDB pool (source "${this.sourceId}"): background connection error, pool will retry:`,
          err.message
        );
      });

      // Test the connection and detect the server flavor in the same round trip.
      const rows = await this.pool.query("SELECT VERSION() AS version");
      this.supportsReadOnlyTransaction = !isTiDBVersion(rows?.[0]?.version);
    } catch (err) {
      // Tear down the pool if it was created before the failure, otherwise it
      // strands sockets and keeps the event loop alive (see closeQuietly).
      if (this.pool) {
        const pool = this.pool;
        this.pool = null;
        await closeQuietly(() => pool.end());
      }
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

  /**
   * Row-array query adapter over the pool for the shared MySQL-family
   * introspection and health-check code. Throws when not connected, so the
   * shared functions never see a missing pool. The mariadb driver already
   * resolves to the rows themselves.
   */
  private requireQuery(): MySQLFamilyQuery {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }
    const pool = this.pool;
    return (sql, params) =>
      (params === undefined ? pool.query(sql) : pool.query(sql, params)) as Promise<any[]>;
  }

  async getSchemas(): Promise<string[]> {
    return introspection.getSchemas(this.requireQuery());
  }

  async getTables(schema?: string): Promise<string[]> {
    return introspection.getTables(this.requireQuery(), schema);
  }

  async getViews(schema?: string): Promise<string[]> {
    return introspection.getViews(this.requireQuery(), schema);
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    return introspection.tableExists(this.requireQuery(), tableName, schema);
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    return introspection.getTableIndexes(this.requireQuery(), tableName, schema);
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    return introspection.getTableSchema(this.requireQuery(), tableName, schema);
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    return introspection.getTableComment(this.requireQuery(), tableName, schema);
  }

  async getHealthCheck(): Promise<HealthCheckResult> {
    return getMySQLFamilyHealthCheck(this.requireQuery());
  }

  async getStoredProcedures(schema?: string, routineType?: "procedure" | "function"): Promise<string[]> {
    return introspection.getStoredProcedures(this.requireQuery(), schema, routineType);
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    return introspection.getStoredProcedureDetail(this.requireQuery(), procedureName, schema);
  }

  async getDefaultSchema(): Promise<string | null> {
    return introspection.getDefaultSchema(this.requireQuery());
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    // Get a dedicated connection from the pool to ensure session consistency
    // This is critical for session-specific features like LAST_INSERT_ID()
    const conn = await this.pool.getConnection();
    let isConnectionDiscarded = false;
    try {
      // Engine-level read-only backstop (shared with MySQL); see
      // withReadOnlyTransaction for the semantics and the TiDB caveat.
      return await withReadOnlyTransaction(
        conn,
        options.readonly,
        this.supportsReadOnlyTransaction,
        async () => {
          // Split up front so the original statement text is available for
          // attribution below, whether or not maxRows needs to rewrite it.
          const statements = splitSQLStatements(sql, "mariadb");
          let processedSQL = sql;
          // Per-statement truncation-probe flags, index-aligned with `statements`
          let probes: boolean[] = [];
          if (options.maxRows) {
            const rewrites = statements.map(statement =>
              SQLRowLimiter.applyMaxRowsWithTruncationProbe(statement, options.maxRows, "mariadb")
            );
            probes = rewrites.map(rewrite => rewrite.probeApplied);

            processedSQL = rewrites.map(rewrite => rewrite.sql).join('; ');
            if (sql.trim().endsWith(';')) {
              processedSQL += ';';
            }
          }

          // Use dedicated connection - MariaDB driver returns rows directly for single statements
          // Pass parameters if provided
          // Bounded by the client-side fallback deadline, which trails the
          // server-side max_statement_time (see query-timeout.ts).
          const results: any = await withClientQueryDeadline(
            parameters && parameters.length > 0
              ? conn.query(processedSQL, parameters)
              : conn.query(processedSQL),
            this.clientQueryTimeoutMs
          );

          // Parse results using shared utility that handles both single and multi-statement queries
          const resultSets = parseQueryResultSets(results, statements);

          // Result sets are per statement in source order, so a length match
          // means the pairing with the probe flags is exact (same reasoning as
          // the sql attribution inside parseQueryResultSets).
          if (resultSets.length === probes.length) {
            resultSets.forEach((set, index) =>
              SQLRowLimiter.flagTruncation(set, options.maxRows, probes[index])
            );
          }

          return { resultSets };
        }
      );
    } catch (error) {
      if (isClientSideTimeout(error)) {
        // The statement is still running on the server and this connection is
        // still waiting for its response, so it must not go back to the pool.
        // The driver's destroy() closes the socket and, because a command is
        // in flight, also issues `KILL <thread id>` over a fresh connection of
        // its own, which ends the statement on the server. That covers both
        // halves of the shared cleanup (discard + server-side cancel).
        isConnectionDiscarded = true;
        conn.destroy();
      }
      throw error;
    } finally {
      if (!isConnectionDiscarded) {
        conn.release();
      }
    }
  }
}

// Create and register the connector
const mariadbConnector = new MariaDBConnector();
ConnectorRegistry.register(mariadbConnector);
