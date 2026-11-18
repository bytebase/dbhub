import type {
  Connector,
  ConnectorConfig,
  ConnectorType,
  DSNParser,
  ExecuteOptions,
  HealthCheckResult,
  SQLResult,
  StoredProcedure,
  TableColumn,
  TableIndex,
} from "./interface.js";
import { getMySQLFamilyHealthCheck } from "./mysql-family-health-check.js";
import * as introspection from "./mysql-family-introspection.js";
import type { MySQLFamilyQuery } from "./mysql-family-introspection.js";
import { parseQueryResultSets } from "../utils/multi-statement-result-parser.js";
import { splitSQLStatements } from "../utils/sql-parser.js";
import { SQLRowLimiter } from "../utils/sql-row-limiter.js";

/**
 * What the MySQL and MariaDB connectors have in common.
 *
 * The two speak the same SQL and read the same catalog, so introspection,
 * health checks and the shape of a statement batch are shared here. They
 * differ in their driver: how a pool is built, how a query is issued and
 * timed out, and how a timed-out connection is discarded. Those parts stay in
 * each subclass, which supplies them through `requireQuery` and the `runQuery`
 * callback of `executeStatements`.
 */
export abstract class MySQLFamilyConnector implements Connector {
  abstract id: ConnectorType;
  abstract name: string;
  abstract dsnParser: DSNParser;

  // Source ID is set by ConnectorManager after cloning
  protected sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  abstract clone(): Connector;
  abstract connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult>;

  /**
   * Row-array query adapter over the driver's pool, for the shared
   * introspection and health-check code. Must throw when not connected, so the
   * shared functions never see a missing pool.
   */
  protected abstract requireQuery(): MySQLFamilyQuery;

  async getSchemas(): Promise<string[]> {
    return introspection.getSchemas(this.requireQuery());
  }

  async getTables(schema?: string): Promise<string[]> {
    return introspection.getTables(this.requireQuery(), schema);
  }

  async getViews(schema?: string): Promise<string[]> {
    return introspection.getViews(this.requireQuery(), schema);
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

  /**
   * Run a statement batch the way both drivers need it run: split it, apply
   * the row cap (with a truncation probe row) to each statement, send the
   * rewritten batch in one round trip, and turn what comes back into one
   * result set per statement.
   *
   * `runQuery` issues the rewritten SQL on the caller's dedicated connection
   * and resolves to `[results, fields]` as fetched positionally — rows as
   * arrays with the column metadata alongside — so parseQueryResultSets can
   * rebuild them under unique column names (bytebase/dbhub#484).
   */
  protected async executeStatements(
    sql: string,
    options: ExecuteOptions,
    runQuery: (processedSQL: string) => Promise<[results: any, fields: any]>
  ): Promise<SQLResult> {
    // Split up front so the original statement text is available for
    // attribution below, whether or not maxRows needs to rewrite it.
    const statements = splitSQLStatements(sql, this.id);
    let processedSQL = sql;
    // Per-statement truncation-probe flags, index-aligned with `statements`
    let probes: boolean[] = [];
    if (options.maxRows) {
      const rewrites = statements.map((statement) =>
        SQLRowLimiter.applyMaxRowsWithTruncationProbe(statement, options.maxRows, this.id)
      );
      probes = rewrites.map((rewrite) => rewrite.probeApplied);

      processedSQL = rewrites.map((rewrite) => rewrite.sql).join("; ");
      if (sql.trim().endsWith(";")) {
        processedSQL += ";";
      }
    }

    const [results, fields] = await runQuery(processedSQL);

    // Handles both single and multi-statement results
    const resultSets = parseQueryResultSets(results, statements, fields);

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
}
