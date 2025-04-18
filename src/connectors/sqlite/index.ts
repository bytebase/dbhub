/**
 * SQLite Connector Implementation
 *
 * Implements SQLite database connectivity for DBHub using better-sqlite3
 * To use this connector:
 * 1. Set DSN=sqlite:///path/to/database.db in your .env file
 * 2. Or set DB_CONNECTOR_TYPE=sqlite for default in-memory database
 */

import { allowedKeywords } from '../../utils/allowed-keywords.js';
import {
  Connector,
  ConnectorRegistry,
  DSNParser,
  QueryResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
} from '../interface.js';
import Database from 'better-sqlite3';

/**
 * SQLite DSN Parser
 * Handles DSN strings like:
 * - sqlite:///path/to/database.db (absolute path)
 * - sqlite://./relative/path/to/database.db (relative path)
 * - sqlite::memory: (in-memory database)
 */
class SQLiteDSNParser implements DSNParser {
  async parse(dsn: string): Promise<{ dbPath: string }> {
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      throw new Error(`Invalid SQLite DSN: ${dsn}`);
    }

    try {
      const url = new URL(dsn);
      let dbPath: string;

      // Handle in-memory database
      if (url.hostname === '' && url.pathname === ':memory:') {
        dbPath = ':memory:';
      }
      // Handle file paths
      else {
        // Get the path part, handling both relative and absolute paths
        if (url.pathname.startsWith('//')) {
          // Absolute path: sqlite:///path/to/db.sqlite
          dbPath = url.pathname.substring(2); // Remove leading //
        } else {
          // Relative path: sqlite://./path/to/db.sqlite
          dbPath = url.pathname;
        }
      }

      return { dbPath };
    } catch (error) {
      throw new Error(`Failed to parse SQLite DSN: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getSampleDSN(): string {
    return 'sqlite:///path/to/database.db';
  }

  isValidDSN(dsn: string): boolean {
    try {
      const url = new URL(dsn);
      return url.protocol === 'sqlite:';
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
  id = 'sqlite';
  name = 'SQLite';
  dsnParser = new SQLiteDSNParser();

  private db: Database.Database | null = null;
  private dbPath: string = ':memory:'; // Default to in-memory database

  async connect(dsn: string, initScript?: string): Promise<void> {
    const config = await this.dsnParser.parse(dsn);
    this.dbPath = config.dbPath;

    try {
      this.db = new Database(this.dbPath);
      console.error('Successfully connected to SQLite database');

      // If an initialization script is provided, run it
      if (initScript) {
        this.db.exec(initScript);
        console.error('Successfully initialized database with script');
      }
    } catch (error) {
      console.error('Failed to connect to SQLite database:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
        this.db = null;
      } catch (error) {
        throw error;
      }
    }
    return Promise.resolve();
  }

  async getSchemas(): Promise<string[]> {
    if (!this.db) {
      throw new Error('Not connected to SQLite database');
    }

    // SQLite doesn't have the concept of schemas like PostgreSQL or MySQL
    // It has a concept of "attached databases" where each database has a name
    // The default database is called 'main', and others can be attached with names
    // We return the database name or 'main' for in-memory databases as the "schema"
    return [this.dbPath === ':memory:' ? 'main' : this.dbPath];
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.db) {
      throw new Error('Not connected to SQLite database');
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
      throw new Error('Not connected to SQLite database');
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
      throw new Error('Not connected to SQLite database');
    }

    // In SQLite, schema parameter is ignored (no schema concept)
    try {
      // Get all indexes for the specified table
      const indexInfoRows = this.db
        .prepare(
          `
        SELECT 
          name as index_name,
          CASE 
            WHEN "unique" = 1 THEN 1
            ELSE 0
          END as is_unique
        FROM sqlite_master 
        WHERE type = 'index' 
        AND tbl_name = ?
      `
        )
        .all(tableName) as { index_name: string; is_unique: number }[];

      // Get the primary key info
      const tableInfo = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as SQLiteTableInfo[];

      // Find primary key columns
      const pkColumns = tableInfo.filter((col) => col.pk > 0).map((col) => col.name);

      const results: TableIndex[] = [];

      // Add regular indexes
      for (const indexInfo of indexInfoRows) {
        // Get the columns for this index
        const indexDetailRows = this.db.prepare(`PRAGMA index_info(${indexInfo.index_name})`).all() as {
          name: string;
        }[];
        const columnNames = indexDetailRows.map((row) => row.name);

        results.push({
          index_name: indexInfo.index_name,
          column_names: columnNames,
          is_unique: indexInfo.is_unique === 1,
          is_primary: false,
        });
      }

      // Add primary key if it exists
      if (pkColumns.length > 0) {
        results.push({
          index_name: 'PRIMARY',
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
      throw new Error('Not connected to SQLite database');
    }

    // In SQLite, schema parameter is ignored for the following reasons:
    // 1. SQLite doesn't have schemas in the same way as PostgreSQL or MySQL
    // 2. Each SQLite database file is its own separate namespace
    // 3. The PRAGMA commands operate on the current database connection
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as SQLiteTableInfo[];

      // Convert SQLite schema format to our standard TableColumn format
      const columns = rows.map((row) => ({
        column_name: row.name,
        data_type: row.type,
        is_nullable: row.notnull === 0 ? 'YES' : 'NO', // In SQLite, 0 means nullable
        column_default: row.dflt_value,
      }));

      return columns;
    } catch (error) {
      throw error;
    }
  }

  async getStoredProcedures(schema?: string): Promise<string[]> {
    if (!this.db) {
      throw new Error('Not connected to SQLite database');
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
      throw new Error('Not connected to SQLite database');
    }

    // SQLite doesn't have true stored procedures:
    // 1. SQLite doesn't support the CREATE PROCEDURE syntax
    // 2. User-defined functions are created programmatically, not stored in the DB
    // 3. Cannot introspect program-defined functions through SQL

    // Throw an error since SQLite doesn't support stored procedures
    throw new Error(
      'SQLite does not support stored procedures. Functions are defined programmatically through the SQLite API, not stored in the database.'
    );
  }

  async executeQuery(query: string): Promise<QueryResult> {
    if (!this.db) {
      throw new Error('Not connected to SQLite database');
    }

    // Validate query for safety
    const safetyCheck = this.validateQuery(query);
    if (!safetyCheck.isValid) {
      throw new Error(safetyCheck.message || 'Query validation failed');
    }

    try {
      const rows = this.db.prepare(query).all();
      return { rows };
    } catch (error) {
      throw error;
    }
  }

  validateQuery(query: string): { isValid: boolean; message?: string } {
    // Basic check to prevent non-SELECT queries
    const normalizedQuery = query.trim().toLowerCase();
    if (!allowedKeywords.some((keyword) => normalizedQuery.startsWith(keyword))) {
      return {
        isValid: false,
        message: 'Only SELECT queries are allowed for security reasons.',
      };
    }
    return { isValid: true };
  }
}

// Register the SQLite connector
const sqliteConnector = new SQLiteConnector();
ConnectorRegistry.register(sqliteConnector);
