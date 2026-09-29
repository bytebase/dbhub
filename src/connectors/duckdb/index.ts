// src/connectors/duckdb/index.ts
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import {
  Connector,
  ConnectorType,
  DSNParser,
  ConnectorConfig,
  ExecuteOptions,
  SQLResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ConnectorRegistry,
} from "../interface.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";

// ------------------------------------------------------------
// DSN Parser
// ------------------------------------------------------------
class DuckDBDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<{ dbPath: string }> {
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      throw new Error(
        `Invalid DuckDB DSN: ${obfuscatedDSN}\nExpected format: ${this.getSampleDSN()}`
      );
    }

    const pathMatch = dsn.match(/^duckdb:\/\/(.+)$/);
    if (!pathMatch) throw new Error("Could not extract database path from DSN");

    let dbPath = pathMatch[1];
    // Windows drive paths: strip leading "/" so DuckDB does not treat it as UNC
    if (/^\/[A-Za-z]:[\\/]/.test(dbPath)) {
      dbPath = dbPath.slice(1);
    }
    return { dbPath };
  }

  getSampleDSN(): string {
    return "duckdb:///path/to/database.duckdb";
  }

  isValidDSN(dsn: string): boolean {
    return /^duckdb:\/\/(.+)\.duckdb$/.test(dsn) || dsn === "duckdb://:memory:";
  }
}

// ------------------------------------------------------------
// Connector
// ------------------------------------------------------------
class DuckDBConnector implements Connector {
  id: ConnectorType = "duckdb";
  name = "DuckDB";
  dsnParser = new DuckDBDSNParser();

  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new DuckDBConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    const parsed = await this.dsnParser.parse(dsn, config);
    this.instance = await DuckDBInstance.fromCache(parsed.dbPath);
    this.connection = await this.instance.connect();
    if (initScript) {
      await this.connection.run(initScript);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      this.connection.closeSync();
      this.connection = null;
    }
    this.instance = null;
  }

  async getSchemas(): Promise<string[]> {
    const res = await this.connection!.run(
      "SELECT schema_name FROM information_schema.schemata"
    );
    return res.getRowObjectsJS().map((r) => r.schema_name as string);
  }

  async getTables(schema?: string): Promise<string[]> {
    const target = schema ?? "main";
    const res = await this.connection!.run(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = '${target}'`
    );
    return res.getRowObjectsJS().map((r) => r.table_name as string);
  }

  async getViews(schema?: string): Promise<string[]> {
    const target = schema ?? "main";
    const res = await this.connection!.run(
      `SELECT table_name FROM information_schema.views
       WHERE table_schema = '${target}'`
    );
    return res.getRowObjectsJS().map((r) => r.table_name as string);
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    const target = schema ?? "main";
    const res = await this.connection!.run(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = '${target}' AND table_name = '${tableName}'
       ORDER BY ordinal_position`
    );
    return res.getRowObjectsJS().map((r) => ({
      column_name: r.column_name as string,
      data_type: r.data_type as string,
      is_nullable: r.is_nullable as string,
      column_default: (r.column_default as string | null) ?? null,
      description: null,
    }));
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    const target = schema ?? "main";
    const res = await this.connection!.run(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables
       WHERE table_schema = '${target}' AND table_name = '${tableName}'`
    );
    const rows = res.getRowObjectsJS();
    return rows.length > 0 && Number(rows[0].cnt) > 0;
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    const target = schema ?? "main";
    const res = await this.connection!.run(
      `SELECT index_name, is_unique, is_primary, expressions
       FROM duckdb_indexes()
       WHERE schema_name = '${target}' AND table_name = '${tableName}'`
    );
    return res.getRowObjectsJS().map((r) => ({
      index_name: r.index_name as string,
      column_names: (r.expressions as string[]) ?? [],
      is_unique: Boolean(r.is_unique),
      is_primary: Boolean(r.is_primary),
    }));
  }

  async getStoredProcedures(
    _schema?: string,
    _routineType?: "procedure" | "function"
  ): Promise<string[]> {
    return [];
  }

  async getStoredProcedureDetail(
    _procedureName: string,
    _schema?: string
  ): Promise<StoredProcedure> {
    throw new Error("DuckDB does not support stored procedures");
  }

  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    const target = schema ?? "main";
    const res = await this.connection!.run(
      `SELECT estimated_size FROM duckdb_tables()
       WHERE schema_name = '${target}' AND table_name = '${tableName}'`
    );
    const rows = res.getRowObjectsJS();
    return rows.length ? Number(rows[0].estimated_size) : null;
  }

  async getTableComment(_tableName: string, _schema?: string): Promise<string | null> {
    return null;
  }

  async executeSQL(
    sql: string,
    options: ExecuteOptions,
    parameters?: any[]
  ): Promise<SQLResult> {
    let result;
    if (parameters?.length) {
      const prepared = await this.connection!.prepare(sql);
      result = await prepared.run(...parameters);
    } else {
      result = await this.connection!.run(sql);
    }

    const allRows = await result.getRowObjectsJS();

    const rows = options.maxRows
      ? allRows.slice(0, options.maxRows)
      : allRows;

    return {
      resultSets: [
        {
          rows,
          rowCount: rows.length,
        },
      ],
    };
  }
}

// ------------------------------------------------------------
// Self-registration
// ------------------------------------------------------------
const duckdbConnector = new DuckDBConnector();
ConnectorRegistry.register(duckdbConnector);

export { DuckDBConnector, DuckDBDSNParser };