/**
 * SQLite Connector Implementation
 *
 * Implements SQLite database connectivity for DBHub using the built-in
 * `node:sqlite` module. This requires Node.js >= 22.5.0 and needs no native
 * compilation (no node-gyp / better-sqlite3 prebuilds).
 * To use this connector: Set DSN=sqlite:///path/to/database.db in your .env file
 */

import fs from "fs";
import path from "path";
import type { DatabaseSync as SqliteDatabase, StatementSync } from "node:sqlite";
import { suppressSqliteExperimentalWarning } from "./suppress-experimental-warning.js";
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
import { quoteIdentifier } from "../../utils/identifier-quoter.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { splitSQLStatements, stripCommentsAndStrings } from "../../utils/sql-parser.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";
import { objectRows } from "../../utils/result-columns.js";
import {
  SQLITE_DSN_PREFIX,
  SQLITE_MEMORY_PATH,
  resolveSqliteDsnPath,
} from "../../utils/sqlite-dsn.js";

/**
 * SQLite DSN Parser
 * Handles DSN strings like:
 * - sqlite:///path/to/database.db (absolute path)
 * - sqlite:///./relative/path/to/database.db (relative to the working directory)
 * - sqlite:///:memory: (in-memory database)
 *
 * The full set of accepted forms is documented in utils/sqlite-dsn.ts. The
 * returned dbPath is always absolute (or `:memory:`), so it names the file that
 * is actually opened.
 *
 * Note: SQLite is a local file-based database and does not support connection timeouts.
 * The config parameter is accepted for interface compliance but ignored.
 */
class SQLiteDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<{ dbPath: string }> {
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid SQLite DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      return { dbPath: resolveSqliteDsnPath(dsn) };
    } catch (error) {
      throw new Error(
        `Failed to parse SQLite DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "sqlite:///path/to/database.db";
  }

  isValidDSN(dsn: string): boolean {
    return typeof dsn === "string" && dsn.startsWith(SQLITE_DSN_PREFIX);
  }
}

/**
 * Build the error for a SQLite database file that could not be opened, naming
 * the resolved path. SQLite itself only reports "unable to open database file",
 * which says neither which file nor why.
 */
function openFailure(dbPath: string, error?: unknown, missingFileNote = ""): Error {
  const prefix = `Unable to open SQLite database file '${dbPath}'`;
  const pathHint =
    "A SQLite DSN path is absolute after three slashes (sqlite:///path/to/database.db); " +
    "write sqlite:///./database.db for a relative path.";

  const directory = path.dirname(dbPath);
  if (!fs.existsSync(directory)) {
    return new Error(`${prefix}: directory '${directory}' does not exist. ${pathHint}`);
  }
  if (!fs.existsSync(dbPath)) {
    return new Error(`${prefix}: the file does not exist.${missingFileNote} ${pathHint}`);
  }
  return new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error,
  });
}

interface SQLiteTableInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SQLiteTableNameRow {
  name: string;
}

export class SQLiteConnector implements Connector {
  id: ConnectorType = "sqlite";
  name = "SQLite";
  dsnParser = new SQLiteDSNParser();

  private db: SqliteDatabase | null = null;
  private dbPath: string = ":memory:"; // Default to in-memory database

  // Source ID is set by ConnectorManager after cloning
  private sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new SQLiteConnector();
  }

  /**
   * Prepare a user-facing query statement with BigInt reads enabled, so 64-bit
   * integer values in the result rows keep full precision.
   *
   * better-sqlite3 exposed this connection-wide via `defaultSafeIntegers(true)`;
   * `node:sqlite` only offers it per-statement via `setReadBigInts`. This is for
   * `executeSQL` only — schema introspection reads small integer flags and uses
   * `queryAll`/`queryOne` (plain numbers) so comparisons like `=== 1` work.
   */
  private prepare(sql: string): StatementSync {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  }

  /**
   * Reads every row of a prepared execute_sql statement as objects.
   *
   * node:sqlite's `all()` keys each row by column name, so a result with a
   * repeated name (`SELECT 1 AS a, 2 AS a`) keeps only the last value
   * (bytebase/dbhub#484). Where the runtime offers positional rows
   * (`setReturnArrays`, with `columns()` for the names - Node 22.17+/24+),
   * the rows are read that way and rebuilt under unique names, repeated ones
   * suffixed `_1`, `_2`, ... (see result-columns.ts). Older runtimes fall
   * back to the driver's own objects.
   */
  private readRows(statement: StatementSync, parameters: any[]): Record<string, unknown>[] {
    const positional = statement as unknown as {
      columns?: () => { name: string }[];
      setReturnArrays?: (enabled: boolean) => void;
    };
    if (typeof positional.columns !== "function" || typeof positional.setReturnArrays !== "function") {
      return statement.all(...parameters);
    }
    const names = positional.columns().map((column) => column.name);
    positional.setReturnArrays(true);
    return objectRows(names, statement.all(...parameters) as unknown as unknown[][]);
  }

  /**
   * Run an introspection query and return all rows. Integers come back as plain
   * numbers (no `setReadBigInts`), which is what the schema-reading callers need
   * for boolean flag comparisons. node:sqlite types `.all()` as a generic record
   * array, so the result is cast to the caller's expected row shape.
   */
  private queryAll<T>(sql: string, ...params: any[]): T[] {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  /** Run an introspection query and return a single row (or undefined). */
  private queryOne<T>(sql: string, ...params: any[]): T | undefined {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  /**
   * Connect to SQLite database
   * Note: SQLite does not support connection timeouts as it's a local file-based database.
   * The config parameter is accepted for interface compliance but ignored.
   */
  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    const parsedConfig = await this.dsnParser.parse(dsn, config);
    this.dbPath = parsedConfig.dbPath;

    const isMemory = this.dbPath === SQLITE_MEMORY_PATH;

    // Install the experimental-warning hook before node:sqlite is loaded, then
    // import it lazily. Doing both here keeps the global process.emitWarning
    // patch scoped to processes that actually use SQLite (node:sqlite emits the
    // warning at module-load time, so the hook must precede the import).
    suppressSqliteExperimentalWarning();
    const { DatabaseSync } = await import("node:sqlite");

    // SDK-level readonly enforcement: Pass readOnly option to node:sqlite
    // Note: In-memory databases (:memory:) cannot be opened in readonly mode
    const dbOptions: ConstructorParameters<typeof DatabaseSync>[1] = {
      // node:sqlite enables foreign key constraints by default, whereas
      // better-sqlite3 (and SQLite's own default) leaves them off. Preserve
      // the historical behavior; callers can opt in via `PRAGMA foreign_keys = ON`.
      enableForeignKeyConstraints: false,
    };
    if (config?.readonly && !isMemory) {
      dbOptions.readOnly = true;
    }

    // Opening a writable connection to a missing file creates it. Refuse when
    // the file is required to exist; otherwise say which file was created.
    const existed = isMemory || fs.existsSync(this.dbPath);
    if (!existed && config?.requireExistingFile) {
      throw openFailure(
        this.dbPath,
        undefined,
        " It was not created because no tool on this source can write to it."
      );
    }

    try {
      this.db = new DatabaseSync(this.dbPath, dbOptions);
    } catch (error) {
      throw openFailure(this.dbPath, error);
    }

    if (!existed) {
      console.error(
        `Warning: SQLite database file '${this.dbPath}' did not exist; created a new, empty database.`
      );
    }

    try {
      // If an initialization script is provided, run it
      if (initScript) {
        this.db.exec(initScript);
      }
    } catch (error) {
      // Close the handle, otherwise the database file stays locked (see closeQuietly).
      const db = this.db;
      this.db = null;
      await closeQuietly(() => db.close());
      console.error("Failed to connect to SQLite database:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        // Check if the database is still open before attempting to close.
        // `isTransaction` exists at runtime (Node >= 22.5) but isn't yet in the
        // installed @types/node, so we read it through a narrow cast.
        const inTransaction = (this.db as SqliteDatabase & { isTransaction: boolean })
          .isTransaction;
        if (!inTransaction) {
          this.db.close();
        } else {
          // If in transaction, try to rollback first
          try {
            this.db.exec('ROLLBACK');
          } catch (rollbackError) {
            // Ignore rollback errors, proceed with close
          }
          this.db.close();
        }
        this.db = null;
      } catch (error) {
        // Log the error but don't throw to prevent test failures
        console.error('Error during SQLite disconnect:', error);
        this.db = null;
      }
    }
    return Promise.resolve();
  }

  async getSchemas(): Promise<string[]> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // SQLite doesn't have the concept of schemas like PostgreSQL or MySQL
    // It has a concept of "attached databases" where each database has a name
    // The default database is called 'main', and others can be attached with names
    // We always return 'main' as the default schema name
    return ["main"];
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // In SQLite, schema parameter is ignored since SQLite doesn't have schemas like PostgreSQL
    // SQLite has a single namespace for tables within a database file
    // You could use 'schema.table' syntax if you have attached databases, but we're
    // accessing the 'main' database by default
    const rows = this.queryAll<SQLiteTableNameRow>(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    return rows.map((row) => row.name);
  }

  async getViews(schema?: string): Promise<string[]> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // In SQLite, schema parameter is ignored since SQLite doesn't have schemas like PostgreSQL
    const rows = this.queryAll<SQLiteTableNameRow>(`
      SELECT name FROM sqlite_master
      WHERE type='view' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    return rows.map((row) => row.name);
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // In SQLite, schema parameter is ignored (no schema concept)
    // Get all indexes for the specified table
    const indexInfoRows = this.queryAll<{ index_name: string; is_unique: number }>(
      `
      SELECT
        name as index_name,
        0 as is_unique
      FROM sqlite_master
      WHERE type = 'index'
      AND tbl_name = ?
    `,
      tableName
    );

    // Get unique info from PRAGMA index_list which provides the unique flag
    // Note: PRAGMA commands require proper identifier quoting for special characters
    const quotedTableName = quoteIdentifier(tableName, "sqlite");
    const indexListRows = this.queryAll<{ name: string; unique: number }>(
      `PRAGMA index_list(${quotedTableName})`
    );

    // Create a map of index names to unique status
    const indexUniqueMap = new Map<string, boolean>();
    for (const indexListRow of indexListRows) {
      indexUniqueMap.set(indexListRow.name, indexListRow.unique === 1);
    }

    // Get the primary key info
    const tableInfo = this.queryAll<SQLiteTableInfo>(`PRAGMA table_info(${quotedTableName})`);

    // Find primary key columns
    const pkColumns = tableInfo.filter((col) => col.pk > 0).map((col) => col.name);

    const results: TableIndex[] = [];

    // Add regular indexes
    for (const indexInfo of indexInfoRows) {
      // Get the columns for this index
      const quotedIndexName = quoteIdentifier(indexInfo.index_name, "sqlite");
      const indexDetailRows = this.queryAll<{ name: string }>(
        `PRAGMA index_info(${quotedIndexName})`
      );
      const columnNames = indexDetailRows.map((row) => row.name);

      results.push({
        index_name: indexInfo.index_name,
        column_names: columnNames,
        is_unique: indexUniqueMap.get(indexInfo.index_name) || false,
        is_primary: false,
      });
    }

    // Add primary key if it exists
    if (pkColumns.length > 0) {
      results.push({
        index_name: "PRIMARY",
        column_names: pkColumns,
        is_unique: true,
        is_primary: true,
      });
    }

    return results;
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // In SQLite, schema parameter is ignored for the following reasons:
    // 1. SQLite doesn't have schemas in the same way as PostgreSQL or MySQL
    // 2. Each SQLite database file is its own separate namespace
    // 3. The PRAGMA commands operate on the current database connection
    const quotedTableName = quoteIdentifier(tableName, "sqlite");
    // table_info omits generated columns. Keep them, but exclude virtual-table
    // implementation columns (hidden=1) exposed by table_xinfo.
    const rows = this.queryAll<SQLiteTableInfo & { hidden: number }>(
      `PRAGMA table_xinfo(${quotedTableName})`
    ).filter((row) => row.hidden !== 1);

    // Convert SQLite schema format to our standard TableColumn format
    // SQLite does not support column comments, so description is always null
    const columns = rows.map((row) => ({
      column_name: row.name,
      data_type: row.type,
      // In SQLite, primary key columns are automatically NOT NULL even if notnull=0
      is_nullable: (row.notnull === 1 || row.pk > 0) ? "NO" : "YES",
      column_default: row.dflt_value,
      description: null,
    }));

    return columns;
  }

  async getStoredProcedures(schema?: string, routineType?: "procedure" | "function"): Promise<string[]> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // SQLite doesn't have built-in stored procedures like other databases.
    // While SQLite does support user-defined functions, these are registered through
    // the C/C++ API or language bindings and cannot be introspected through SQL.
    // Triggers exist in SQLite but they're not the same as stored procedures.
    //
    // We return an empty array because:
    // 1. SQLite has no native stored procedure concept
    // 2. User-defined functions cannot be listed via SQL queries
    // 3. We don't want to misrepresent triggers as stored procedures

    return []; // routineType parameter accepted but ignored for SQLite
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // SQLite doesn't have true stored procedures:
    // 1. SQLite doesn't support the CREATE PROCEDURE syntax
    // 2. User-defined functions are created programmatically, not stored in the DB
    // 3. Cannot introspect program-defined functions through SQL

    // Throw an error since SQLite doesn't support stored procedures
    throw new Error(
      "SQLite does not support stored procedures. Functions are defined programmatically through the SQLite API, not stored in the database."
    );
  }


  /**
   * Whether a statement returns rows (and so must run via `all()` rather than
   * `run()`).
   *
   * The prepared statement's own column list is the driver's answer and is
   * used where the runtime exposes it (`columns()`, Node 22.17+/24+): it covers
   * every pragma that reports a value (`PRAGMA user_version`,
   * `PRAGMA table_xinfo(t)`, ...) and `INSERT ... RETURNING`, none of which a
   * keyword list can enumerate.
   *
   * The keyword check stays as the fallback for older supported runtimes
   * (Node 22.5 - 22.16 have no `columns()`) and for statements that have always
   * been read through `all()` despite having no columns (ANALYZE). It is
   * classified on the comment/string-stripped text so a leading attribution
   * comment cannot hide a SELECT, matching the row limiter and the read-only
   * classifier. Every PRAGMA counts: `all()` runs a pragma that reports nothing
   * just as well, returning no rows. A DML statement counts when it carries a
   * RETURNING clause; the stripped text has no strings, comments or quoted
   * identifiers left, so the word can only be the keyword.
   */
  private returnsRows(prepared: StatementSync, statement: string): boolean {
    const withColumns = prepared as unknown as { columns?: () => unknown[] };
    if (typeof withColumns.columns === "function" && withColumns.columns().length > 0) {
      return true;
    }
    const stripped = stripCommentsAndStrings(statement, "sqlite").toLowerCase().trim();
    return stripped.startsWith('select') ||
           stripped.startsWith('with') ||
           stripped.startsWith('explain') ||
           stripped.startsWith('analyze') ||
           stripped.startsWith('pragma') ||
           (/^(?:insert|update|delete|replace)\b/.test(stripped) && /\breturning\b/.test(stripped));
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // Engine-level read-only backstop: PRAGMA query_only=ON makes SQLite reject any
    // write (including header-writing pragmas like `PRAGMA user_version=N` and
    // `wal_checkpoint(...)`) regardless of what the keyword classifier allowed. The
    // body below runs synchronously (node:sqlite is sync), so no other executeSQL
    // call can interleave between toggling the flag on and restoring it.
    if (options.readonly) {
      this.db.exec("PRAGMA query_only = ON");
    }

    try {
      const statements = splitSQLStatements(sql, "sqlite");
      const isSingleStatement = statements.length === 1;

      // Parameters are not supported for multi-statement queries
      if (!isSingleStatement && parameters && parameters.length > 0) {
        throw new Error("Parameters are not supported for multi-statement queries in SQLite");
      }
      const statementParameters = isSingleStatement ? (parameters ?? []) : [];

      // Execute each statement individually, in source order, so a later
      // statement sees the effects of earlier ones and result sets line up
      // with the batch as written.
      const resultSets: SQLResultSet[] = [];
      for (const statement of statements) {
        // Re-assert the read-only backstop before each statement so an earlier
        // statement in the batch (e.g. `PRAGMA query_only = OFF` / `query_only(0)`)
        // cannot disable it for the ones that follow.
        if (options.readonly) {
          this.db.exec("PRAGMA query_only = ON");
        }

        // Apply maxRows limit (with a truncation probe row) to SELECT queries
        // if specified (not PRAGMA/ANALYZE)
        const { sql: processedStatement, probeApplied } = SQLRowLimiter.applyMaxRowsWithTruncationProbe(
          statement,
          options.maxRows,
          "sqlite"
        );

        const prepared = this.prepare(processedStatement);
        if (this.returnsRows(prepared, statement)) {
          const rows = this.readRows(prepared, statementParameters);
          const resultSet: SQLResultSet = { sql: statement, rows, rowCount: rows.length };
          SQLRowLimiter.flagTruncation(resultSet, options.maxRows, probeApplied);
          resultSets.push(resultSet);
        } else {
          // Use run() for statements that don't return data.
          // node:sqlite returns `changes` as BigInt when BigInt reads are
          // enabled; normalize to a number to match the SQLResult contract.
          const result = prepared.run(...statementParameters);
          resultSets.push({ sql: statement, rows: [], rowCount: Number(result.changes) });
        }
      }

      return { resultSets };
    } finally {
      // Restore the connection to writable so non-read-only tools on the same
      // shared connection are unaffected. Best-effort: if this throws it must not
      // mask the primary execution error (the expected read-only rejection).
      if (options.readonly) {
        try {
          this.db.exec("PRAGMA query_only = OFF");
        } catch {
          // ignore; preserve the original error
        }
      }
    }
  }
}

// Register the SQLite connector
const sqliteConnector = new SQLiteConnector();
ConnectorRegistry.register(sqliteConnector);
