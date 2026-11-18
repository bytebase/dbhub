import mysql from "mysql2/promise";
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
import { buildMySQLSessionStatement } from "../../utils/session-settings.js";
import {
  withReadOnlyTransaction,
  detectReadOnlyBackstop,
  noBackstopWarning,
  VERSION_COMMENT_QUERY,
  type ReadOnlyBackstop,
} from "../../utils/readonly-transaction.js";
import {
  CANCEL_QUERY_TIMEOUT_MS,
  clientQueryTimeoutMs,
  isClientSideTimeout,
} from "../../utils/query-timeout.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";

/**
 * mysql2 `ssl` option for an sslmode. mysql2 verifies the certificate chain by
 * default but checks the host name only with `verifyIdentity`. A fresh object
 * per call: the driver writes defaults back onto the one it is given.
 */
function mysqlSslOptions(mode: MySQLFamilySslMode): mysql.PoolOptions["ssl"] {
  switch (mode) {
    case "disable":
      return undefined;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
      return { rejectUnauthorized: true };
    case "verify-full":
      return { rejectUnauthorized: true, verifyIdentity: true };
  }
}

/**
 * MySQL DSN Parser
 * Handles DSN strings like: mysql://user:password@localhost:3306/dbname?sslmode=require
 * Supported SSL modes (anything else is rejected):
 * - sslmode=disable: No SSL connection
 * - sslmode=require: SSL connection without certificate verification
 * - sslmode=verify-ca: SSL connection, certificate chain verified
 * - sslmode=verify-full: verify-ca plus the certificate must match the host name
 */
class MySQLDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<mysql.PoolOptions> {
    const connectionTimeoutSeconds = config?.connectionTimeoutSeconds;
    const poolMaxConnections = config?.poolMaxConnections;
    // Capture these before the local `config` (mysql.PoolOptions) shadows the param below
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

      const config: mysql.PoolOptions = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 3306,
        database,
        user: url.username,
        password: url.password,
        multipleStatements: true, // Enable native multi-statement support
        supportBigNumbers: true, // Return BIGINT as string when value exceeds Number.MAX_SAFE_INTEGER
      };

      // Read from the raw DSN: a present-but-empty sslmode must be rejected,
      // and SafeURL would have dropped it (see readMySQLFamilySslMode)
      const sslmode = readMySQLFamilySslMode(dsn);
      if (sslmode !== undefined) {
        config.ssl = mysqlSslOptions(sslmode);
      }

      // Apply connection timeout if specified
      if (connectionTimeoutSeconds !== undefined) {
        // mysql2 library expects connectTimeout in milliseconds
        config.connectTimeout = connectionTimeoutSeconds * 1000;
      }

      // mysql2 defaults to 10 connections per pool; callers beyond the limit
      // wait for a free connection.
      if (poolMaxConnections !== undefined) {
        config.connectionLimit = poolMaxConnections;
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

/** The callback-style connection mysql2 passes to the pool's 'connection' event. */
interface RawPoolConnection {
  query(sql: string, callback: (err: unknown) => void): void;
  stream: { destroy(err?: Error): void };
}

/**
 * Run `statement` on every new pool connection before anything else, and fail
 * closed: if it errors, the connection is destroyed so the caller's statement,
 * queued right behind it, is never sent and rejects with that error instead of
 * running without the settings. At startup this surfaces as a failed connect.
 *
 * The socket is destroyed synchronously inside the callback, while the caller's
 * statement is still in the connection's queue. Destroying the stream (rather
 * than calling connection.destroy()) routes the error through mysql2's fatal
 * error path, which rejects every queued statement and drops the connection
 * from the pool.
 */
export function applyOnEveryConnection(pool: mysql.Pool, statement: string): void {
  (pool as unknown as NodeJS.EventEmitter).on("connection", (connection: RawPoolConnection) => {
    connection.query(statement, (err) => {
      if (err) {
        connection.stream.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Take a connection from the pool, giving up after `timeoutMs` when every
 * connection is in use, as pg-pool does with connectionTimeoutMillis. mysql2
 * has no limit of its own: a caller beyond connectionLimit waits in the pool's
 * queue indefinitely. The request stays queued after a timeout, so the
 * connection it is eventually handed goes straight back to the pool.
 */
export async function getConnectionWithin(
  pool: mysql.Pool,
  timeoutMs: number | undefined
): Promise<mysql.PoolConnection> {
  const pending = pool.getConnection();
  if (timeoutMs === undefined) {
    return pending;
  }
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Timed out after ${timeoutMs} ms waiting for a free connection from the pool`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      pending.then(
        (conn) => conn.release(),
        () => {}
      );
    }
  }
}

/**
 * MySQL Connector Implementation
 */
export class MySQLConnector extends MySQLFamilyConnector {
  id: ConnectorType = "mysql";
  name = "MySQL";
  dsnParser = new MySQLDSNParser();

  private pool: mysql.Pool | null = null;
  private queryTimeoutMs?: number;
  // connection_timeout also bounds the wait for a free pool connection
  private connectionTimeoutMs?: number;
  // How the read-only backstop takes effect on this server (which session
  // variable to save/restore; TiDB rejects `START TRANSACTION READ ONLY`
  // unless tidb_enable_noop_functions is on; Apache Doris has no transactional
  // backstop at all). Detected once at connect time. MySQL-compatible servers
  // are special-cased here only: the MariaDB connector does no such detection.
  private readOnlyBackstop: ReadOnlyBackstop = { kind: "session", variable: "transaction_read_only" };

  clone(): Connector {
    return new MySQLConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const connectionOptions = await this.dsnParser.parse(dsn, config);
      this.pool = mysql.createPool(connectionOptions);
      this.connectionTimeoutMs =
        config?.connectionTimeoutSeconds !== undefined
          ? config.connectionTimeoutSeconds * 1000
          : undefined;

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

      // Per-source [sources.session] settings become the default of every new
      // connection. Unlike max_execution_time above, a failure is not ignored.
      const sessionStatement =
        config?.sessionSettings !== undefined
          ? buildMySQLSessionStatement(config.sessionSettings)
          : undefined;
      if (sessionStatement !== undefined) {
        applyOnEveryConnection(this.pool, sessionStatement);
      }

      // Test the connection and detect the server flavor in the same round trip.
      const [rows] = (await this.pool.query("SELECT VERSION() AS version")) as [any[], any];
      this.readOnlyBackstop = detectReadOnlyBackstop(
        rows[0]?.version,
        await this.probeVersionComment()
      );
      if (this.readOnlyBackstop.kind === "none") {
        console.error(noBackstopWarning(this.sourceId));
      }
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

  /**
   * Reads `@@version_comment`, which identifies MySQL-protocol servers whose
   * `VERSION()` looks stock (Apache Doris). Best effort: a server without the
   * variable yields undefined, which keeps the default read-only backstop.
   */
  private async probeVersionComment(): Promise<unknown> {
    try {
      const [rows] = (await this.pool!.query(VERSION_COMMENT_QUERY)) as [any[], any];
      return rows[0]?.version_comment;
    } catch {
      return undefined;
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
  protected requireQuery(): MySQLFamilyQuery {
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

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    // Get a dedicated connection from the pool to ensure session consistency
    // This is critical for session-specific features like LAST_INSERT_ID()
    const conn = await getConnectionWithin(this.pool, this.connectionTimeoutMs);
    // Captured up front, before a timeout can lead to conn.destroy() below.
    const threadId = conn.threadId;
    let isConnectionDiscarded = false;
    // The client-side deadline trails the server-side one (see query-timeout.ts).
    const timeout =
      this.queryTimeoutMs !== undefined ? clientQueryTimeoutMs(this.queryTimeoutMs) : undefined;
    try {
      // Engine-level read-only backstop (shared with MariaDB); see
      // withReadOnlyTransaction for the semantics and the TiDB/Doris caveats.
      return await withReadOnlyTransaction(
        conn,
        options.readonly,
        this.readOnlyBackstop,
        () =>
          this.executeStatements(sql, options, (processedSQL) => {
            // Use dedicated connection with multipleStatements: true support
            // Pass parameters if provided, with optional query timeout.
            // Rows are fetched positionally (rowsAsArray); mysql2 resolves to
            // [rows, fields], which is what executeStatements expects.
            const queryOptions = { sql: processedSQL, timeout, rowsAsArray: true };
            return (
              parameters && parameters.length > 0
                ? conn.query(queryOptions, parameters)
                : conn.query(queryOptions)
            ) as Promise<[any, any]>;
          })
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
