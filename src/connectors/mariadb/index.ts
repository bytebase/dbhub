import * as mariadb from "mariadb";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  ExecuteOptions,
  ConnectorConfig,
} from "../interface.js";
import { MySQLFamilyConnector } from "../mysql-family-connector.js";
import type { MySQLFamilyQuery } from "../mysql-family-introspection.js";
import { readMySQLFamilySslMode, type MySQLFamilySslMode } from "../mysql-family-ssl.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { requireDatabaseInDSN, MissingDatabaseError } from "../../utils/dsn-database.js";
import {
  withReadOnlyTransaction,
  MARIADB_READ_ONLY_BACKSTOP,
} from "../../utils/readonly-transaction.js";
import {
  clientQueryTimeoutMs,
  isClientSideTimeout,
  withClientQueryDeadline,
} from "../../utils/query-timeout.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";

/**
 * mariadb driver `ssl` option for an sslmode. With certificate verification
 * on, the driver also checks the host name unless `checkServerIdentity` is
 * set — so verify-ca supplies a no-op one, and verify-full leaves it unset.
 * The driver's typings only declare the secure-context half of the TLS
 * options, hence the cast; it reads `checkServerIdentity` off this object.
 * A fresh object per call: the driver writes defaults back onto it.
 */
function mariadbSslOptions(mode: MySQLFamilySslMode): mariadb.ConnectionConfig["ssl"] {
  switch (mode) {
    case "disable":
      return undefined;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
      return {
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      } as mariadb.ConnectionConfig["ssl"];
    case "verify-full":
      return { rejectUnauthorized: true };
  }
}

/**
 * MariaDB DSN Parser
 * Handles DSN strings like: mariadb://user:password@localhost:3306/dbname?sslmode=require
 * Supported SSL modes (anything else is rejected):
 * - sslmode=disable: No SSL connection
 * - sslmode=require: SSL connection without certificate verification
 * - sslmode=verify-ca: SSL connection, certificate chain verified
 * - sslmode=verify-full: verify-ca plus the certificate must match the host name
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

      // Read from the raw DSN: a present-but-empty sslmode must be rejected,
      // and SafeURL would have dropped it (see readMySQLFamilySslMode)
      const sslmode = readMySQLFamilySslMode(dsn);
      if (sslmode !== undefined) {
        connectionConfig.ssl = mariadbSslOptions(sslmode);
      }

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
export class MariaDBConnector extends MySQLFamilyConnector {
  id: ConnectorType = "mariadb";
  name = "MariaDB";
  dsnParser = new MariadbDSNParser();

  private pool: mariadb.Pool | null = null;
  // Client-side fallback deadline; the mariadb driver has no client-side
  // timer of its own (see query-timeout.ts).
  private clientQueryTimeoutMs?: number;

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

      // Test the connection. No server detection here: MySQL-compatible
      // servers (TiDB, Apache Doris, ...) are special-cased on the MySQL
      // connector only, and are expected to be reached through `mysql://`.
      await this.pool.query("SELECT 1");
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
  protected requireQuery(): MySQLFamilyQuery {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }
    const pool = this.pool;
    return (sql, params) =>
      (params === undefined ? pool.query(sql) : pool.query(sql, params)) as Promise<any[]>;
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
      // withReadOnlyTransaction for the semantics.
      return await withReadOnlyTransaction(
        conn,
        options.readonly,
        MARIADB_READ_ONLY_BACKSTOP,
        () =>
          this.executeStatements(sql, options, (processedSQL) => {
            // Use dedicated connection. Rows are fetched positionally
            // (rowsAsArray) with the column metadata alongside (metaAsArray:
            // `[rows, meta]`, per statement for a batch), which is what
            // executeStatements expects.
            // Pass parameters if provided
            // Bounded by the client-side fallback deadline, which trails the
            // server-side max_statement_time (see query-timeout.ts).
            const queryOptions = { sql: processedSQL, rowsAsArray: true, metaAsArray: true };
            return withClientQueryDeadline(
              parameters && parameters.length > 0
                ? conn.query(queryOptions, parameters)
                : conn.query(queryOptions),
              this.clientQueryTimeoutMs
            ) as Promise<[any, any]>;
          })
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
