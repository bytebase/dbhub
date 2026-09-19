import oracledb from "oracledb";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  SQLResultSet,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { splitSQLStatements, stripCommentsAndStrings } from "../../utils/sql-parser.js";
import { isReadOnlySQL } from "../../utils/allowed-keywords.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";

/**
 * Everything the connector needs to open a pool, derived from the DSN and the
 * per-source ConnectorConfig.
 */
export interface OracleConnectionConfig {
  user: string;
  password: string;
  /** Easy Connect string: `[tcps://]host:port/service` */
  connectString: string;
  /** Seconds to wait for the whole Oracle Net handshake */
  connectTimeout?: number;
  /** Per-statement round-trip timeout, in milliseconds */
  callTimeoutMs?: number;
  /** Verify the server certificate's DN against the hostname (sslmode=verify-full) */
  sslServerDNMatch?: boolean;
  poolMax: number;
}

/**
 * Oracle DSN parser
 * Expected format: oracle://user:password@host:1521/service_name
 *
 * The path is the service name (the normal way to address a pluggable
 * database, e.g. FREEPDB1). An old-style SID can be given instead with
 * `?sid=ORCL`. `sslmode=require` switches the transport to TCPS without
 * certificate DN checks; `sslmode=verify-full` also checks the DN.
 */
export class OracleDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<OracleConnectionConfig> {
    if (!this.isValidDSN(dsn)) {
      throw new Error(
        `Invalid Oracle DSN format.\nProvided: ${obfuscateDSNPassword(dsn)}\nExpected: ${this.getSampleDSN()}`
      );
    }

    try {
      const url = new SafeURL(dsn);

      let sslmode: string | undefined;
      let sid: string | undefined;
      url.forEachSearchParam((value, key) => {
        if (key === "sslmode") {
          sslmode = value;
        } else if (key === "sid") {
          sid = value;
        }
      });

      if (sslmode !== undefined && !["disable", "require", "verify-full"].includes(sslmode)) {
        throw new Error(
          `Unsupported sslmode '${sslmode}' for Oracle. Supported: disable, require, verify-full`
        );
      }

      const host = url.hostname;
      const port = url.port ? parseInt(url.port, 10) : 1521;
      const service = url.pathname ? url.pathname.substring(1) : "";
      if (!host) {
        throw new Error("Oracle DSN must include a host");
      }
      if (!service && !sid) {
        throw new Error("Oracle DSN must include a service name in the path (or ?sid=)");
      }

      const useTls = sslmode === "require" || sslmode === "verify-full";
      let connectString: string;
      if (sid) {
        // Easy Connect has no SID form; use a full connect descriptor.
        const protocol = useTls ? "TCPS" : "TCP";
        connectString =
          `(DESCRIPTION=(ADDRESS=(PROTOCOL=${protocol})(HOST=${host})(PORT=${port}))` +
          `(CONNECT_DATA=(SID=${sid})))`;
      } else {
        connectString = `${useTls ? "tcps://" : ""}${host}:${port}/${service}`;
      }

      return {
        user: url.username,
        password: url.password,
        connectString,
        ...(config?.connectionTimeoutSeconds !== undefined && {
          connectTimeout: config.connectionTimeoutSeconds,
        }),
        ...(config?.queryTimeoutSeconds !== undefined && {
          callTimeoutMs: config.queryTimeoutSeconds * 1000,
        }),
        ...(useTls && { sslServerDNMatch: sslmode === "verify-full" }),
        poolMax: config?.poolMaxConnections ?? 4,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse Oracle DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "oracle://username:password@localhost:1521/FREEPDB1?sslmode=disable";
  }

  isValidDSN(dsn: string): boolean {
    return dsn.startsWith("oracle://");
  }
}

/**
 * Oracle connector, built on node-oracledb's Thin mode (pure JavaScript, no
 * Oracle Instant Client needed).
 *
 * Identifier case: Oracle folds unquoted identifiers to upper case, so the
 * catalog stores `users` as `USERS`. Every metadata lookup therefore matches a
 * name as given *or* upper-cased, which lets callers pass the lower-case names
 * they wrote in their DDL while still finding a case-sensitive quoted
 * identifier by its exact spelling. Names are returned exactly as the catalog
 * holds them.
 */
export class OracleConnector implements Connector {
  id: ConnectorType = "oracle";
  name = "Oracle";
  dsnParser = new OracleDSNParser();

  private pool?: oracledb.Pool;
  private config?: OracleConnectionConfig;
  /** CURRENT_SCHEMA of the connected session, resolved once at connect time */
  private defaultSchema?: string;
  // Source ID is set by ConnectorManager after cloning
  private sourceId: string = "default";

  /** Leading whitespace and SQL comments to skip before looking for a keyword. */
  private static readonly LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

  /**
   * A PL/SQL block or a DDL statement that contains one. These must reach the
   * server as a single statement with their internal semicolons intact, so
   * they are never split on `;`.
   */
  private static readonly PLSQL_BLOCK =
    /^(?:begin|declare|create\s+(?:or\s+replace\s+)?(?:(?:editionable|noneditionable)\s+)?(?:procedure|function|package|trigger|type))\b/i;

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new OracleConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      this.config = await this.dsnParser.parse(dsn, config);

      this.pool = await oracledb.createPool({
        user: this.config.user,
        password: this.config.password,
        connectString: this.config.connectString,
        poolMin: 0,
        poolMax: this.config.poolMax,
        poolIncrement: 1,
        ...(this.config.connectTimeout !== undefined && {
          connectTimeout: this.config.connectTimeout,
        }),
        ...(this.config.sslServerDNMatch !== undefined && {
          sslServerDNMatch: this.config.sslServerDNMatch,
        }),
      });

      // Resolve the session's default schema once; it doubles as the
      // connection smoke test so a bad credential fails here, not on first use.
      const connection = await this.acquire();
      try {
        const result = await connection.execute<{ SCHEMA_NAME: string }>(
          "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS schema_name FROM dual",
          {},
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        this.defaultSchema = result.rows?.[0]?.SCHEMA_NAME ?? this.config.user.toUpperCase();
      } finally {
        await connection.close();
      }

      if (initScript) {
        await this.executeSQL(initScript, {});
      }
    } catch (error) {
      // Tear down the pool if it was created before the failure, otherwise it
      // strands sockets and keeps the event loop alive (see closeQuietly).
      if (this.pool) {
        const pool = this.pool;
        this.pool = undefined;
        await closeQuietly(() => pool.close(0));
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      const pool = this.pool;
      this.pool = undefined;
      await pool.close(0);
    }
  }

  /** Check out a pooled connection with the configured statement timeout applied. */
  private async acquire(): Promise<oracledb.Connection> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    const connection = await this.pool.getConnection();
    if (this.config?.callTimeoutMs !== undefined) {
      connection.callTimeout = this.config.callTimeoutMs;
    }
    return connection;
  }

  /**
   * Run one catalog query on a short-lived pooled connection. Binds are named
   * so a value can be referenced twice (`:name` and `UPPER(:name)`).
   */
  private async query<T>(sql: string, binds: oracledb.BindParameters = {}): Promise<T[]> {
    const connection = await this.acquire();
    try {
      const result = await connection.execute<T>(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchTypeHandler: OracleConnector.fetchLobsAsString,
      });
      return result.rows ?? [];
    } finally {
      await connection.close();
    }
  }

  /**
   * Fetch CLOB/NCLOB columns as strings instead of Lob streams, so result rows
   * are plain JSON. (LONG columns such as ALL_TAB_COLUMNS.DATA_DEFAULT are
   * already fetched as strings by default.)
   */
  private static fetchLobsAsString(metaData: oracledb.Metadata<unknown>) {
    if (metaData.dbType === oracledb.DB_TYPE_CLOB || metaData.dbType === oracledb.DB_TYPE_NCLOB) {
      return { type: oracledb.STRING };
    }
    return undefined;
  }

  /**
   * The schema to query, upper-cased the way Oracle folds an unquoted
   * identifier, unless the caller spelled a schema that exists as given.
   * Callers pass the result to a `= :schema OR = UPPER(:schema)` predicate,
   * so both spellings are honoured.
   */
  private schemaOrDefault(schema?: string): string {
    if (schema) {
      return schema;
    }
    if (!this.defaultSchema) {
      throw new Error("Not connected to Oracle database");
    }
    return this.defaultSchema;
  }

  async getSchemas(): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      // Every Oracle user is a schema; the ~35 Oracle-maintained accounts
      // (SYS, SYSTEM, XDB, ...) are noise for schema exploration, so list only
      // application users plus the session's own schema.
      const rows = await this.query<{ USERNAME: string }>(
        `SELECT username
         FROM all_users
         WHERE oracle_maintained = 'N' OR username = :current_schema
         ORDER BY username`,
        { current_schema: this.defaultSchema ?? '' }
      );
      return rows.map((row) => row.USERNAME);
    } catch (error) {
      throw new Error(`Failed to get schemas: ${(error as Error).message}`);
    }
  }

  async getDefaultSchema(): Promise<string | null> {
    return this.defaultSchema ?? null;
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      const rows = await this.query<{ TABLE_NAME: string }>(
        `SELECT table_name
         FROM all_tables
         WHERE (owner = :schema OR owner = UPPER(:schema))
           AND nested = 'NO'
           AND secondary = 'N'
           AND (iot_type IS NULL OR iot_type = 'IOT')
           AND table_name NOT LIKE 'BIN$%'
         ORDER BY table_name`,
        { schema: this.schemaOrDefault(schema) }
      );
      return rows.map((row) => row.TABLE_NAME);
    } catch (error) {
      throw new Error(`Failed to get tables: ${(error as Error).message}`);
    }
  }

  async getViews(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      const rows = await this.query<{ VIEW_NAME: string }>(
        `SELECT view_name
         FROM all_views
         WHERE owner = :schema OR owner = UPPER(:schema)
         ORDER BY view_name`,
        { schema: this.schemaOrDefault(schema) }
      );
      return rows.map((row) => row.VIEW_NAME);
    } catch (error) {
      throw new Error(`Failed to get views: ${(error as Error).message}`);
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      const rows = await this.query<{ CNT: number }>(
        `SELECT COUNT(*) AS cnt
         FROM all_tables
         WHERE (owner = :schema OR owner = UPPER(:schema))
           AND (table_name = :table_name OR table_name = UPPER(:table_name))`,
        { schema: this.schemaOrDefault(schema), table_name: tableName }
      );
      return Number(rows[0]?.CNT ?? 0) > 0;
    } catch (error) {
      throw new Error(`Failed to check if table exists: ${(error as Error).message}`);
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      const rows = await this.query<{
        COLUMN_NAME: string;
        DATA_TYPE: string;
        DATA_LENGTH: number | null;
        CHAR_LENGTH: number | null;
        DATA_PRECISION: number | null;
        DATA_SCALE: number | null;
        NULLABLE: string;
        DATA_DEFAULT: string | null;
        DESCRIPTION: string | null;
      }>(
        `SELECT c.column_name,
                c.data_type,
                c.data_length,
                c.char_length,
                c.data_precision,
                c.data_scale,
                c.nullable,
                c.data_default,
                cc.comments AS description
         FROM all_tab_columns c
         LEFT JOIN all_col_comments cc
           ON cc.owner = c.owner
          AND cc.table_name = c.table_name
          AND cc.column_name = c.column_name
         WHERE (c.owner = :schema OR c.owner = UPPER(:schema))
           AND (c.table_name = :table_name OR c.table_name = UPPER(:table_name))
         ORDER BY c.column_id`,
        { schema: this.schemaOrDefault(schema), table_name: tableName }
      );

      return rows.map((row) => ({
        column_name: row.COLUMN_NAME,
        data_type: OracleConnector.formatDataType(row),
        is_nullable: row.NULLABLE === "Y" ? "YES" : "NO",
        // DATA_DEFAULT is a LONG that keeps the DDL's trailing whitespace.
        column_default: row.DATA_DEFAULT?.trim() || null,
        description: row.DESCRIPTION || null,
      }));
    } catch (error) {
      throw new Error(`Failed to get schema for table ${tableName}: ${(error as Error).message}`);
    }
  }

  /**
   * Render a column's type the way it appears in DDL: `VARCHAR2(100)`,
   * `NUMBER(10,2)`, `NUMBER`, `TIMESTAMP(6)`. Oracle's catalog splits these
   * across several columns.
   */
  private static formatDataType(row: {
    DATA_TYPE: string;
    DATA_LENGTH: number | null;
    CHAR_LENGTH: number | null;
    DATA_PRECISION: number | null;
    DATA_SCALE: number | null;
  }): string {
    const type = row.DATA_TYPE;
    if (/^(?:N?VARCHAR2|N?CHAR|RAW)$/.test(type)) {
      const length = type === "RAW" ? row.DATA_LENGTH : row.CHAR_LENGTH;
      return length ? `${type}(${length})` : type;
    }
    if (type === "NUMBER") {
      if (row.DATA_PRECISION === null) {
        return type;
      }
      return row.DATA_SCALE ? `NUMBER(${row.DATA_PRECISION},${row.DATA_SCALE})` : `NUMBER(${row.DATA_PRECISION})`;
    }
    if (type === "FLOAT" && row.DATA_PRECISION !== null) {
      return `FLOAT(${row.DATA_PRECISION})`;
    }
    // TIMESTAMP(6), TIMESTAMP(6) WITH TIME ZONE, INTERVAL DAY(2) TO SECOND(6)
    // already carry their precision in DATA_TYPE.
    return type;
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      const rows = await this.query<{
        INDEX_NAME: string;
        UNIQUENESS: string;
        IS_PRIMARY: number;
        COLUMN_NAME: string;
      }>(
        `SELECT i.index_name,
                i.uniqueness,
                CASE WHEN pk.constraint_name IS NOT NULL THEN 1 ELSE 0 END AS is_primary,
                ic.column_name
         FROM all_indexes i
         JOIN all_ind_columns ic
           ON ic.index_owner = i.owner
          AND ic.index_name = i.index_name
         LEFT JOIN all_constraints pk
           ON pk.owner = i.table_owner
          AND pk.table_name = i.table_name
          AND pk.constraint_type = 'P'
          AND pk.index_owner = i.owner
          AND pk.index_name = i.index_name
         WHERE (i.table_owner = :schema OR i.table_owner = UPPER(:schema))
           AND (i.table_name = :table_name OR i.table_name = UPPER(:table_name))
         ORDER BY i.index_name, ic.column_position`,
        { schema: this.schemaOrDefault(schema), table_name: tableName }
      );

      const indexMap = new Map<string, TableIndex>();
      for (const row of rows) {
        let index = indexMap.get(row.INDEX_NAME);
        if (!index) {
          index = {
            index_name: row.INDEX_NAME,
            column_names: [],
            is_unique: row.UNIQUENESS === "UNIQUE",
            is_primary: Number(row.IS_PRIMARY) === 1,
          };
          indexMap.set(row.INDEX_NAME, index);
        }
        index.column_names.push(row.COLUMN_NAME);
      }
      return Array.from(indexMap.values());
    } catch (error) {
      throw new Error(`Failed to get indexes for table ${tableName}: ${(error as Error).message}`);
    }
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      const rows = await this.query<{ COMMENTS: string | null }>(
        `SELECT comments
         FROM all_tab_comments
         WHERE (owner = :schema OR owner = UPPER(:schema))
           AND (table_name = :table_name OR table_name = UPPER(:table_name))`,
        { schema: this.schemaOrDefault(schema), table_name: tableName }
      );
      return rows[0]?.COMMENTS || null;
    } catch {
      return null;
    }
  }

  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      // Optimizer statistics; NULL until the table has been analyzed, which
      // search_objects reports as an unknown count rather than a stale one.
      const rows = await this.query<{ NUM_ROWS: number | null }>(
        `SELECT num_rows
         FROM all_tables
         WHERE (owner = :schema OR owner = UPPER(:schema))
           AND (table_name = :table_name OR table_name = UPPER(:table_name))`,
        { schema: this.schemaOrDefault(schema), table_name: tableName }
      );
      const numRows = rows[0]?.NUM_ROWS;
      return numRows === null || numRows === undefined ? null : Number(numRows);
    } catch {
      return null;
    }
  }

  async getStoredProcedures(schema?: string, routineType?: "procedure" | "function"): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      const types =
        routineType === "function"
          ? ["FUNCTION"]
          : routineType === "procedure"
            ? ["PROCEDURE"]
            : ["PROCEDURE", "FUNCTION"];
      const rows = await this.query<{ OBJECT_NAME: string }>(
        `SELECT object_name
         FROM all_objects
         WHERE (owner = :schema OR owner = UPPER(:schema))
           AND object_type IN (${types.map((_, i) => `:type${i}`).join(", ")})
         ORDER BY object_name`,
        {
          schema: this.schemaOrDefault(schema),
          ...Object.fromEntries(types.map((type, i) => [`type${i}`, type])),
        }
      );
      return rows.map((row) => row.OBJECT_NAME);
    } catch (error) {
      throw new Error(`Failed to get stored procedures: ${(error as Error).message}`);
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }
    try {
      const schemaToUse = this.schemaOrDefault(schema);
      const binds = { schema: schemaToUse, name: procedureName };

      const objects = await this.query<{ OBJECT_NAME: string; OBJECT_TYPE: string }>(
        `SELECT object_name, object_type
         FROM all_objects
         WHERE (owner = :schema OR owner = UPPER(:schema))
           AND (object_name = :name OR object_name = UPPER(:name))
           AND object_type IN ('PROCEDURE', 'FUNCTION')`,
        binds
      );
      if (objects.length === 0) {
        throw new Error(`Stored procedure '${procedureName}' not found in schema '${schemaToUse}'`);
      }
      const object = objects[0];
      const isFunction = object.OBJECT_TYPE === "FUNCTION";

      // Standalone routines only (package_name IS NULL). Position 0 with no
      // argument name is a function's return value.
      const args = await this.query<{
        ARGUMENT_NAME: string | null;
        POSITION: number;
        IN_OUT: string;
        DATA_TYPE: string | null;
      }>(
        `SELECT argument_name, position, in_out, data_type
         FROM all_arguments
         WHERE (owner = :schema OR owner = UPPER(:schema))
           AND object_name = :object_name
           AND package_name IS NULL
           AND data_level = 0
         ORDER BY position`,
        { schema: schemaToUse, object_name: object.OBJECT_NAME }
      );

      const returnType = args.find((arg) => arg.POSITION === 0 && arg.ARGUMENT_NAME === null)?.DATA_TYPE;
      const parameterList = args
        .filter((arg) => arg.ARGUMENT_NAME !== null)
        .map((arg) => `${arg.ARGUMENT_NAME} ${arg.IN_OUT} ${arg.DATA_TYPE ?? ""}`.trim())
        .join(", ");

      const source = await this.query<{ TEXT: string }>(
        `SELECT text
         FROM all_source
         WHERE (owner = :schema OR owner = UPPER(:schema))
           AND name = :object_name
           AND type = :object_type
         ORDER BY line`,
        { schema: schemaToUse, object_name: object.OBJECT_NAME, object_type: object.OBJECT_TYPE }
      );

      return {
        procedure_name: object.OBJECT_NAME,
        procedure_type: isFunction ? "function" : "procedure",
        language: "plsql",
        parameter_list: parameterList,
        return_type: isFunction ? returnType ?? undefined : undefined,
        definition: source.length > 0 ? source.map((row) => row.TEXT).join("") : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to get stored procedure details: ${(error as Error).message}`);
    }
  }

  async executeSQL(sqlQuery: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.pool) {
      throw new Error("Not connected to Oracle database");
    }

    const afterNoise = sqlQuery.slice(sqlQuery.match(OracleConnector.LEADING_NOISE)![0].length);
    if (/^explain\b/i.test(afterNoise)) {
      return this.explainQuery(afterNoise.slice("explain".length), options.readonly, parameters);
    }

    const statements = OracleConnector.splitStatements(afterNoise);
    const binds = parameters ?? [];

    const connection = await this.acquire();
    try {
      // Engine-level read-only enforcement: a READ ONLY transaction makes the
      // server itself reject DML (ORA-01456). DDL is not covered by it (DDL
      // implicitly commits and so ends the transaction), which is why the
      // keyword classifier in front of this connector stays the first line of
      // defense; this is the backstop behind it.
      if (options.readonly) {
        await connection.execute("SET TRANSACTION READ ONLY");
      }

      const resultSets: SQLResultSet[] = [];
      try {
        for (const statement of statements) {
          let processedSQL = statement;
          let probeApplied = false;
          if (options.maxRows) {
            const rewrite = SQLRowLimiter.applyMaxRowsForOracleWithTruncationProbe(
              statement,
              options.maxRows
            );
            processedSQL = rewrite.sql;
            probeApplied = rewrite.probeApplied;
          }

          const result = await connection.execute<Record<string, unknown>>(processedSQL, binds, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            fetchTypeHandler: OracleConnector.fetchLobsAsString,
          });

          const rows = result.rows ?? [];
          const resultSet: SQLResultSet = {
            sql: statement,
            rows,
            rowCount: result.rows ? rows.length : result.rowsAffected ?? 0,
          };
          SQLRowLimiter.flagTruncation(resultSet, options.maxRows, probeApplied);
          resultSets.push(resultSet);
        }

        if (options.readonly) {
          await connection.rollback();
        } else {
          await connection.commit();
        }
      } catch (error) {
        // Best-effort rollback so a failed ROLLBACK cannot mask the original error.
        try {
          await connection.rollback();
        } catch {
          // ignore
        }
        throw error;
      }

      return { resultSets };
    } catch (error) {
      throw new Error(`Failed to execute query: ${(error as Error).message}`);
    } finally {
      await connection.close();
    }
  }

  /**
   * Oracle executes exactly one statement per round trip, and rejects the
   * trailing `;` of a plain SQL statement (ORA-00933) while *requiring* it
   * inside a PL/SQL block. So: a PL/SQL block (or the DDL that creates one)
   * is sent whole, minus any SQL*Plus `/` terminator; anything else is split
   * on top-level semicolons, which the splitter also strips.
   */
  private static splitStatements(sql: string): string[] {
    if (OracleConnector.PLSQL_BLOCK.test(sql)) {
      return [sql.replace(/\s*\/\s*$/, "").trim()];
    }
    return splitSQLStatements(sql, "oracle");
  }

  /**
   * Run `EXPLAIN PLAN FOR <statement>` and return the formatted plan.
   *
   * EXPLAIN PLAN parses and optimizes the statement without executing it. It
   * stores the plan in PLAN_TABLE (a session-private global temporary table),
   * which is why this path runs outside the READ ONLY transaction used by
   * executeSQL and cleans up its rows afterwards.
   *
   * Accepts the Postgres-style `EXPLAIN <stmt>` the explain_sql tool emits as
   * well as Oracle's own `EXPLAIN PLAN [SET STATEMENT_ID = '...'] FOR <stmt>`.
   */
  private async explainQuery(
    afterExplain: string,
    readonly?: boolean,
    parameters?: any[]
  ): Promise<SQLResult> {
    const innerQuery = afterExplain
      .replace(/^\s*plan\b(?:\s+set\s+statement_id\s*=\s*'[^']*')?\s+for\b/i, "")
      .replace(/;\s*$/, "")
      .trim();

    const cleaned = stripCommentsAndStrings(innerQuery, "oracle").trim();
    if (!cleaned) {
      throw new Error("EXPLAIN requires a statement to analyze");
    }
    // EXPLAIN is routed here before the read-only transaction is opened. The
    // explained statement is never executed, but in read-only mode it must
    // still be a read statement so this path cannot become a side channel for
    // parsing DML/DDL under a read-only tool.
    if (readonly && !isReadOnlySQL(innerQuery, "oracle")) {
      throw new Error("Read-only mode: EXPLAIN is only allowed for read statements");
    }

    // STATEMENT_ID is VARCHAR2(30); this is well within it.
    const statementId = `dbhub_${Math.random().toString(36).slice(2, 14)}`;
    const connection = await this.acquire();
    try {
      await connection.execute(
        `EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR ${innerQuery}`,
        parameters ?? []
      );
      const plan = await connection.execute<{ PLAN_TABLE_OUTPUT: string }>(
        "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :id, 'TYPICAL'))",
        { id: statementId },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const lines = (plan.rows ?? []).map((row) => row.PLAN_TABLE_OUTPUT);
      return {
        resultSets: [
          {
            rows: lines.length > 0 ? [{ plan: lines.join("\n") }] : [],
            rowCount: lines.length > 0 ? 1 : 0,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to explain query: ${(error as Error).message}`);
    } finally {
      // PLAN_TABLE preserves rows for the session, and the session goes back
      // to the pool: drop this plan so it cannot pile up or leak to a later
      // caller. Best effort.
      try {
        await connection.execute("DELETE FROM plan_table WHERE statement_id = :id", {
          id: statementId,
        });
        await connection.commit();
      } catch {
        // ignore
      }
      await connection.close();
    }
  }
}

// Create and register the connector
const oracleConnector = new OracleConnector();
ConnectorRegistry.register(oracleConnector);
