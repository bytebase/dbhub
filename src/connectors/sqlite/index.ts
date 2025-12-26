/**
 * SQLite Connector Implementation
 *
 * Implements SQLite database connectivity for DBHub using better-sqlite3
 * To use this connector: Set DSN=sqlite:///path/to/database.db in your .env file
 */

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
import Database from "better-sqlite3";
import { quoteIdentifier } from "../../utils/identifier-quoter.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";

/**
 * SQLite DSN Parser
 * Handles DSN strings like:
 * - sqlite:///path/to/database.db (absolute path)
 * - sqlite://./relative/path/to/database.db (relative path)
 * - sqlite:///:memory: (in-memory database)
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
      // Use SafeURL helper to handle special characters properly
      const url = new SafeURL(dsn);
      let dbPath: string;

      // Handle in-memory database
      if (url.hostname === "" && url.pathname === "/:memory:") {
        dbPath = ":memory:";
      }
      // Handle file paths
      else {
        // Get the path part, handling both relative and absolute paths
        if (url.pathname.startsWith("//")) {
          // Unix absolute path: sqlite:///path/to/db.sqlite
          dbPath = url.pathname.substring(2); // Remove leading //
        } else if (url.pathname.match(/^\/[A-Za-z]:\//)) {
          // Windows absolute path: sqlite:///C:/path/to/db.sqlite
          // URL parser adds leading slash to drive letter paths, so strip it
          dbPath = url.pathname.substring(1);
        } else {
          // Relative path: sqlite://./path/to/db.sqlite
          dbPath = url.pathname;
        }
      }

      return { dbPath };
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
    try {
      return dsn.startsWith('sqlite://');
    } catch (error) {
      return false;
    }
  }
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

  private db: Database.Database | null = null;
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
   * Connect to SQLite database
   * Note: SQLite does not support connection timeouts as it's a local file-based database.
   * The config parameter is accepted for interface compliance but ignored.
   */
  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    const parsedConfig = await this.dsnParser.parse(dsn, config);
    this.dbPath = parsedConfig.dbPath;

    try {
      // SDK-level readonly enforcement: Pass readonly option to better-sqlite3
      // Note: In-memory databases (:memory:) cannot be opened in readonly mode
      const dbOptions: any = {};
      if (config?.readonly && this.dbPath !== ':memory:') {
        dbOptions.readonly = true;
      }

      this.db = new Database(this.dbPath, dbOptions);

      // If an initialization script is provided, run it
      if (initScript) {
        this.db.exec(initScript);
      }
    } catch (error) {
      console.error("Failed to connect to SQLite database:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        // Check if the database is still open before attempting to close
        if (!this.db.inTransaction) {
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
    try {
      const rows = this.db
        .prepare(
          `
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `
        )
        .all() as SQLiteTableNameRow[];

      return rows.map((row) => row.name);
    } catch (error) {
      throw error;
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // In SQLite, schema parameter is ignored since there's only one schema per database file
    // All tables exist in a single namespace within the SQLite database
    try {
      const row = this.db
        .prepare(
          `
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name = ?
      `
        )
        .get(tableName) as SQLiteTableNameRow | undefined;

      return !!row;
    } catch (error) {
      throw error;
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // In SQLite, schema parameter is ignored (no schema concept)
    try {
      // Get all indexes for the specified table
      const indexInfoRows = this.db
        .prepare(
          `
        SELECT 
          name as index_name,
          0 as is_unique
        FROM sqlite_master 
        WHERE type = 'index' 
        AND tbl_name = ?
      `
        )
        .all(tableName) as { index_name: string; is_unique: number }[];

      // Get unique info from PRAGMA index_list which provides the unique flag
      // Note: PRAGMA commands require proper identifier quoting for special characters
      const quotedTableName = quoteIdentifier(tableName, "sqlite");
      const indexListRows = this.db
        .prepare(`PRAGMA index_list(${quotedTableName})`)
        .all() as { name: string; unique: number }[];
      
      // Create a map of index names to unique status
      const indexUniqueMap = new Map<string, boolean>();
      for (const indexListRow of indexListRows) {
        indexUniqueMap.set(indexListRow.name, indexListRow.unique === 1);
      }

      // Get the primary key info
      const tableInfo = this.db
        .prepare(`PRAGMA table_info(${quotedTableName})`)
        .all() as SQLiteTableInfo[];

      // Find primary key columns
      const pkColumns = tableInfo.filter((col) => col.pk > 0).map((col) => col.name);

      const results: TableIndex[] = [];

      // Add regular indexes
      for (const indexInfo of indexInfoRows) {
        // Get the columns for this index
        const quotedIndexName = quoteIdentifier(indexInfo.index_name, "sqlite");
        const indexDetailRows = this.db
          .prepare(`PRAGMA index_info(${quotedIndexName})`)
          .all() as {
          name: string;
        }[];
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
    } catch (error) {
      throw error;
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    // In SQLite, schema parameter is ignored for the following reasons:
    // 1. SQLite doesn't have schemas in the same way as PostgreSQL or MySQL
    // 2. Each SQLite database file is its own separate namespace
    // 3. The PRAGMA commands operate on the current database connection
    try {
      const quotedTableName = quoteIdentifier(tableName, "sqlite");
      const rows = this.db.prepare(`PRAGMA table_info(${quotedTableName})`).all() as SQLiteTableInfo[];

      // Convert SQLite schema format to our standard TableColumn format
      const columns = rows.map((row) => ({
        column_name: row.name,
        data_type: row.type,
        // In SQLite, primary key columns are automatically NOT NULL even if notnull=0
        is_nullable: (row.notnull === 1 || row.pk > 0) ? "NO" : "YES",
        column_default: row.dflt_value,
      }));

      return columns;
    } catch (error) {
      throw error;
    }
  }

  async getStoredProcedures(schema?: string): Promise<string[]> {
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

    return [];
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


  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.db) {
      throw new Error("Not connected to SQLite database");
    }

    try {
      // Check if this is a multi-statement query
      const statements = sql.split(';')
        .map(statement => statement.trim())
        .filter(statement => statement.length > 0);

      if (statements.length === 1) {
        // Single statement - determine if it returns data
        let processedStatement = statements[0];
        const trimmedStatement = statements[0].toLowerCase().trim();
        const isReadStatement = trimmedStatement.startsWith('select') ||
                               trimmedStatement.startsWith('with') ||
                               trimmedStatement.startsWith('explain') ||
                               trimmedStatement.startsWith('analyze') ||
                               (trimmedStatement.startsWith('pragma') &&
                                (trimmedStatement.includes('table_info') ||
                                 trimmedStatement.includes('index_info') ||
                                 trimmedStatement.includes('index_list') ||
                                 trimmedStatement.includes('foreign_key_list')));

        // Apply maxRows limit to SELECT queries if specified (not PRAGMA/ANALYZE)
        if (options.maxRows) {
          processedStatement = SQLRowLimiter.applyMaxRows(processedStatement, options.maxRows);
        }

        if (isReadStatement) {
          // Pass parameters if provided
          if (parameters && parameters.length > 0) {
            try {
              const rows = this.db.prepare(processedStatement).all(...parameters);
              return { rows, rowCount: rows.length };
            } catch (error) {
              console.error(`[SQLite executeSQL] ERROR: ${(error as Error).message}`);
              console.error(`[SQLite executeSQL] SQL: ${processedStatement}`);
              console.error(`[SQLite executeSQL] Parameters: ${JSON.stringify(parameters)}`);
              throw error;
            }
          } else {
            const rows = this.db.prepare(processedStatement).all();
            return { rows, rowCount: rows.length };
          }
        } else {
          // Use run() for statements that don't return data
          let result;
          if (parameters && parameters.length > 0) {
            try {
              result = this.db.prepare(processedStatement).run(...parameters);
            } catch (error) {
              console.error(`[SQLite executeSQL] ERROR: ${(error as Error).message}`);
              console.error(`[SQLite executeSQL] SQL: ${processedStatement}`);
              console.error(`[SQLite executeSQL] Parameters: ${JSON.stringify(parameters)}`);
              throw error;
            }
          } else {
            result = this.db.prepare(processedStatement).run();
          }
          return { rows: [], rowCount: result.changes };
        }
      } else {
        // Multiple statements - parameters not supported for multi-statement queries
        if (parameters && parameters.length > 0) {
          throw new Error("Parameters are not supported for multi-statement queries in SQLite");
        }

        // Use native .exec() for optimal performance
        // Note: .exec() doesn't return results, so we need to handle SELECT statements differently
        const readStatements = [];
        const writeStatements = [];

        // Separate read and write operations
        for (const statement of statements) {
          const trimmedStatement = statement.toLowerCase().trim();
          if (trimmedStatement.startsWith('select') ||
              trimmedStatement.startsWith('with') ||
              trimmedStatement.startsWith('explain') ||
              trimmedStatement.startsWith('analyze') ||
              (trimmedStatement.startsWith('pragma') &&
               (trimmedStatement.includes('table_info') ||
                trimmedStatement.includes('index_info') ||
                trimmedStatement.includes('index_list') ||
                trimmedStatement.includes('foreign_key_list')))) {
            readStatements.push(statement);
          } else {
            writeStatements.push(statement);
          }
        }

        // Execute write statements individually to track changes
        let totalChanges = 0;
        for (const statement of writeStatements) {
          const result = this.db.prepare(statement).run();
          totalChanges += result.changes;
        }

        // Execute read statements individually to collect results
        let allRows: any[] = [];
        for (let statement of readStatements) {
          // Apply maxRows limit to SELECT queries if specified
          statement = SQLRowLimiter.applyMaxRows(statement, options.maxRows);
          const result = this.db.prepare(statement).all();
          allRows.push(...result);
        }

        // rowCount is total changes for writes, plus rows returned for reads
        return { rows: allRows, rowCount: totalChanges + allRows.length };
      }
    } catch (error) {
      throw error;
    }
  }
}

// Register the SQLite connector
const sqliteConnector = new SQLiteConnector();
ConnectorRegistry.register(sqliteConnector);
