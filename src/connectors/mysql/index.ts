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
  CANCEL_QUERY_TIMEOUT_MS,
  clientQueryTimeoutMs,
  isClientSideTimeout,
} from "../../utils/query-timeout.js";
import { isTiDBVersion } from "../../utils/server-flavor.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";

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

      const database = url.pathname ? url.pathname.substring(1) : ''; // Remove leading '/' if exists
      requireDatabaseInDSN(database, dsn, "MySQL");

      const config: mysql.ConnectionOptions = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 3306,
        database,
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
      // Surface the actionable missing-database message as-is
      if (error instanceof MissingDatabaseError) {
        throw error;
      }
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
  // TiDB speaks the MySQL protocol but rejects `START TRANSACTION READ ONLY`
  // unless tidb_enable_noop_functions is on. Detected once at connect time.
  private supportsReadOnlyTransaction: boolean = true;

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

      if (config?.queryTimeoutSeconds !== undefined) {
        const queryTimeoutMs = Math.ceil(config.queryTimeoutSeconds * 1000);
        // Client-side fallback, applied per query (see query-timeout.ts).
        this.queryTimeoutMs = queryTimeoutMs;
        // Server-side limit: have MySQL itself stop a read-only SELECT that
        // runs past the limit, as PostgreSQL (statement_timeout) and MariaDB
        // (max_statement_time) already do. It is a session variable, so it is
        // set once on every new pool connection. mysql2 emits 'connection'
        // with the callback-style connection before handing it to the first
        // caller, so this SET is queued ahead of that caller's statement.
        // max_execution_time does not cover writes or DDL; those stay bounded
        // by the client-side fallback alone. A server without the variable
        // (MySQL before 5.7.8) rejects the SET, which is ignored for the same
        // reason: the fallback still applies.
        const setServerLimit = `SET SESSION max_execution_time = ${queryTimeoutMs}`;
        (this.pool as unknown as NodeJS.EventEmitter).on(
          "connection",
          (connection: { query(sql: string, callback: (err: unknown) => void): void }) => {
            connection.query(setServerLimit, () => {});
          }
        );
      }

      // Test the connection and detect the server flavor in the same round trip.
      const [rows] = (await this.pool.query("SELECT VERSION() AS version")) as [any[], any];
      this.supportsReadOnlyTransaction = !isTiDBVersion(rows[0]?.version);
    } catch (err) {
      // Tear down the pool if it was created before the failure, otherwise it
      // strands sockets and keeps the event loop alive (see closeQuietly).
      if (this.pool) {
        const pool = this.pool;
        this.pool = null;
        await closeQuietly(() => pool.end());
      }
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

  /**
   * Row-array query adapter over the pool for the shared MySQL-family
   * introspection and health-check code. Throws when not connected, so the
   * shared functions never see a missing pool. mysql2 resolves to
   * [rows, fields]; only the rows are handed on.
   */
  private requireQuery(): MySQLFamilyQuery {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }
    const pool = this.pool;
    return async (sql, params) => {
      const [rows] = (await (params === undefined ? pool.query(sql) : pool.query(sql, params))) as [
        any[],
        any,
      ];
      return rows;
    };
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
    // Captured up front, before a timeout can lead to conn.destroy() below.
    const threadId = conn.threadId;
    let isConnectionDiscarded = false;
    // The client-side deadline trails the server-side one (see query-timeout.ts).
    const timeout =
      this.queryTimeoutMs !== undefined ? clientQueryTimeoutMs(this.queryTimeoutMs) : undefined;
    try {
      // Engine-level read-only backstop (shared with MariaDB); see
      // withReadOnlyTransaction for the semantics and the TiDB caveat.
      return await withReadOnlyTransaction(
        conn,
        options.readonly,
        this.supportsReadOnlyTransaction,
        async () => {
          // Split up front so the original statement text is available for
          // attribution below, whether or not maxRows needs to rewrite it.
          const statements = splitSQLStatements(sql, "mysql");
          let processedSQL = sql;
          // Per-statement truncation-probe flags, index-aligned with `statements`
          let probes: boolean[] = [];
          if (options.maxRows) {
            const rewrites = statements.map(statement =>
              SQLRowLimiter.applyMaxRowsWithTruncationProbe(statement, options.maxRows, "mysql")
            );
            probes = rewrites.map(rewrite => rewrite.probeApplied);

            processedSQL = rewrites.map(rewrite => rewrite.sql).join('; ');
            if (sql.trim().endsWith(';')) {
              processedSQL += ';';
            }
          }

          // Use dedicated connection with multipleStatements: true support
          // Pass parameters if provided, with optional query timeout
          let results: any;
          if (parameters && parameters.length > 0) {
            results = await conn.query({ sql: processedSQL, timeout }, parameters);
          } else {
            results = await conn.query({ sql: processedSQL, timeout });
          }

          // MySQL2 returns results in format [rows, fields]
          // Extract the first element which contains the actual row data
          const [firstResult] = results;

          // Parse results using shared utility that handles both single and multi-statement queries
          const resultSets = parseQueryResultSets(firstResult, statements);

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
        // mysql2's `timeout` option only aborts client-side: the statement
        // keeps running on the server, and this connection's command queue
        // still thinks that statement is in flight, so returning it to the
        // pool would silently block whichever caller draws it next. Per
        // mysql2's own documented contract, a timed-out connection must be
        // destroyed, not reused. Destroy it first, so its pool slot is free
        // for the kill below, then best-effort kill the server-side statement
        // so the timeout actually frees whatever the query was holding.
        isConnectionDiscarded = true;
        conn.destroy();
        await this.killQuery(threadId);
      }
      throw error;
    } finally {
      if (!isConnectionDiscarded) {
        conn.release();
      }
    }
  }

  /**
   * Best-effort server-side kill for a query abandoned by mysql2's client-side
   * timeout. Uses a separate connection: the original connection's command
   * queue is stuck behind the abandoned statement (see isClientSideTimeout)
   * and cannot itself be used to send KILL QUERY.
   *
   * Bounded by its own short timeout (CANCEL_QUERY_TIMEOUT_MS), independent
   * of the user's query_timeout.
   */
  private async killQuery(threadId: number): Promise<void> {
    if (!this.pool) return;
    let killer;
    let killerPoisoned = false;
    try {
      killer = await this.pool.getConnection();
      await killer.query({ sql: `KILL QUERY ${threadId}`, timeout: CANCEL_QUERY_TIMEOUT_MS });
    } catch (error) {
      // Unconfirmed cancellation: the statement may still be running on the
      // server. Nothing more to do from here — the caller already sees the
      // timeout error. If the kill itself timed out client-side, this
      // connection is subject to the same stuck-queue hazard as the
      // original one, so it must be destroyed rather than reused.
      killerPoisoned = isClientSideTimeout(error);
    } finally {
      if (killer) {
        if (killerPoisoned) {
          killer.destroy();
        } else {
          killer.release();
        }
      }
    }
  }
}

// Create and register the connector
const mysqlConnector = new MySQLConnector();
ConnectorRegistry.register(mysqlConnector);
