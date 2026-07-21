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
import { isDriverNotInstalled } from "../../utils/module-loader.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { splitSQLStatements, stripCommentsAndStrings } from "../../utils/sql-parser.js";

// Minimal typings for the parts of the @sap/hana-client callback API we use. The
// driver is an optional native dependency imported lazily in connect(), so these
// let the DSN parser and its unit tests load without the package installed.
interface HanaStatementResult {
  [column: string]: unknown;
}
type HanaExecResult = HanaStatementResult[] | number;
interface HanaStatement {
  setTimeout(seconds: number): void;
  exec(params: unknown[], cb: (err: Error | null, rows: HanaExecResult) => void): void;
  drop?(cb?: (err: Error | null) => void): void;
}
interface HanaConnection {
  connect(params: HanaConnectionConfig, cb: (err: Error | null) => void): void;
  exec(sql: string, params: unknown[], cb: (err: Error | null, rows: HanaExecResult) => void): void;
  prepare(sql: string, cb: (err: Error | null, statement: HanaStatement) => void): void;
  disconnect(cb: (err: Error | null) => void): void;
  setAutoCommit(autoCommit: boolean): void;
  rollback(cb: (err: Error | null) => void): void;
}
interface HanaClientModule {
  createConnection(): HanaConnection;
}

function parseBoolParam(key: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`Invalid boolean for '${key}': '${value}'. Use true or false.`);
}

/** Connection properties passed to @sap/hana-client's connect(). */
export interface HanaConnectionConfig {
  host: string;
  port: number;
  uid: string;
  pwd: string;
  encrypt?: boolean;
  sslValidateCertificate?: boolean;
  /** Tenant/database name for a multitenant (MDC) system. */
  databaseName?: string;
  /** Connection timeout in milliseconds. */
  connectTimeout?: number;
}

/**
 * SAP HANA DSN parser.
 *
 * Format: hana://username:password@host:port[/databaseName][?params]
 *   - default port 30015 (tenant SQL port); for MDC name-based routing use the
 *     SYSTEMDB port with the tenant name in the path.
 *   - sslmode maps to encrypt/sslValidateCertificate: disable→off,
 *     require→encrypt, verify-ca/verify-full→encrypt+validate. Explicit
 *     encrypt/sslValidateCertificate params override; verify modes imply encryption.
 */
export class HanaDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<HanaConnectionConfig> {
    if (!this.isValidDSN(dsn)) {
      throw new Error(
        `Invalid SAP HANA DSN format.\nProvided: ${obfuscateDSNPassword(dsn)}\nExpected: ${this.getSampleDSN()}`
      );
    }

    try {
      const url = new SafeURL(dsn);
      if (!url.hostname) {
        throw new Error("SAP HANA DSN must include a host");
      }

      let sslmode: string | undefined;
      let encryptParam: boolean | undefined;
      let sslValidateParam: boolean | undefined;
      let databaseNameParam: string | undefined;

      url.forEachSearchParam((value, key) => {
        switch (key) {
          case "sslmode":
            sslmode = value.trim().toLowerCase();
            break;
          case "encrypt":
            encryptParam = parseBoolParam("encrypt", value);
            break;
          case "sslValidateCertificate":
            sslValidateParam = parseBoolParam("sslValidateCertificate", value);
            break;
          case "databaseName":
            databaseNameParam = value;
            break;
        }
      });

      let encrypt = encryptParam;
      let sslValidateCertificate = sslValidateParam;
      let sslmodeRequiresEncrypt = false;
      if (sslmode !== undefined) {
        switch (sslmode) {
          case "disable":
            encrypt = encryptParam ?? false;
            break;
          case "require":
            encrypt = encryptParam ?? true;
            sslValidateCertificate = sslValidateParam ?? false;
            break;
          case "verify-ca":
          case "verify-full":
            encrypt = encryptParam ?? true;
            sslValidateCertificate = sslValidateParam ?? true;
            sslmodeRequiresEncrypt = true;
            break;
          default:
            throw new Error(
              `Invalid sslmode '${sslmode}'. Valid values: disable, require, verify-ca, verify-full.`
            );
        }
      }

      // Reject config that would silently disable TLS despite a verify mode.
      if (sslmodeRequiresEncrypt && encrypt === false) {
        throw new Error(
          `Contradictory TLS config: sslmode=${sslmode} requires encryption but encrypt=false was given.`
        );
      }
      if (sslValidateCertificate === true && encrypt === false) {
        throw new Error(
          "Contradictory TLS config: sslValidateCertificate=true requires encrypt=true."
        );
      }
      if (sslValidateCertificate === true) {
        encrypt = true;
      }

      const pathDatabase =
        url.pathname && url.pathname.length > 1 ? url.pathname.substring(1) : undefined;
      const databaseName = pathDatabase ?? databaseNameParam;

      const hanaConfig: HanaConnectionConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 30015,
        uid: url.username,
        pwd: url.password,
      };
      if (encrypt !== undefined) hanaConfig.encrypt = encrypt;
      if (sslValidateCertificate !== undefined)
        hanaConfig.sslValidateCertificate = sslValidateCertificate;
      if (databaseName) hanaConfig.databaseName = databaseName;
      if (config?.connectionTimeoutSeconds !== undefined) {
        hanaConfig.connectTimeout = config.connectionTimeoutSeconds * 1000;
      }

      return hanaConfig;
    } catch (error) {
      throw new Error(
        `Failed to parse SAP HANA DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "hana://username:password@localhost:30015?encrypt=true&sslmode=verify-full";
  }

  isValidDSN(dsn: string): boolean {
    return dsn.startsWith("hana://");
  }
}

/**
 * SAP HANA connector (HANA 2.0 and HANA Cloud) on @sap/hana-client.
 *
 * A single connection per source is not safe for concurrent use, and read-only
 * execution mutates transaction state, so every operation is serialized through
 * runExclusive.
 */
export class HanaConnector implements Connector {
  id: ConnectorType = "hana";
  name = "SAP HANA";
  dsnParser = new HanaDSNParser();

  private connection?: HanaConnection;
  private queryTimeoutSeconds?: number;
  private sourceId = "default";
  private opLock: Promise<unknown> = Promise.resolve();

  // Procedural DDL / anonymous blocks whose bodies contain semicolons that are
  // not statement separators.
  private static readonly PROCEDURAL_RE =
    /^\s*(?:create(?:\s+or\s+replace)?|alter)\b[\s\S]*?\b(?:procedure|function|trigger)\b|^\s*do\b/i;

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new HanaConnector();
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opLock.then(fn, fn);
    this.opLock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async connect(dsn: string, _initScript?: string, config?: ConnectorConfig): Promise<void> {
    const params = await this.dsnParser.parse(dsn, config);
    this.queryTimeoutSeconds =
      config?.queryTimeoutSeconds && config.queryTimeoutSeconds > 0
        ? config.queryTimeoutSeconds
        : undefined;

    // Lazy import: the native driver ships a platform-specific binary (glibc, not
    // Alpine/musl), so keep it out of module scope. Mirrors the SQL Server
    // connector's lazy @azure/identity import.
    let hana: HanaClientModule;
    try {
      const mod = await import("@sap/hana-client");
      hana = ((mod as { default?: HanaClientModule }).default ?? mod) as unknown as HanaClientModule;
    } catch (importError) {
      if (isDriverNotInstalled(importError, "@sap/hana-client")) {
        throw new Error(
          'SAP HANA support requires the "@sap/hana-client" package. Install it with: pnpm add @sap/hana-client'
        );
      }
      throw importError;
    }

    const connection = hana.createConnection();
    // Assign before connecting so a failed connect is still reachable for teardown.
    this.connection = connection;
    try {
      await new Promise<void>((resolve, reject) => {
        connection.connect(params, (err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      this.connection = undefined;
      await new Promise<void>((resolve) => {
        try {
          connection.disconnect(() => resolve());
        } catch {
          resolve();
        }
      });
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    this.connection = undefined;
    await new Promise<void>((resolve, reject) => {
      connection.disconnect((err) => (err ? reject(err) : resolve()));
    });
  }

  // Low-level driver call; callers hold the mutex. A configured query timeout
  // needs a prepared statement, otherwise exec() directly.
  private execRaw(sql: string, params: unknown[] = []): Promise<HanaExecResult> {
    const connection = this.connection;
    if (!connection) {
      return Promise.reject(new Error("Not connected to SAP HANA database"));
    }
    const timeout = this.queryTimeoutSeconds;
    if (!timeout) {
      return new Promise<HanaExecResult>((resolve, reject) => {
        connection.exec(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
      });
    }
    return new Promise<HanaExecResult>((resolve, reject) => {
      connection.prepare(sql, (prepErr, statement) => {
        if (prepErr) return reject(prepErr);
        try {
          statement.setTimeout(timeout);
        } catch {
          /* older drivers may lack setTimeout */
        }
        statement.exec(params, (execErr, rows) => {
          try {
            statement.drop?.(() => {});
          } catch {
            /* best effort */
          }
          if (execErr) reject(execErr);
          else resolve(rows);
        });
      });
    });
  }

  private async queryOne(sql: string, params: unknown[] = []): Promise<HanaStatementResult | undefined> {
    const result = await this.execRaw(sql, params);
    return Array.isArray(result) ? result[0] : undefined;
  }

  private async queryAll(sql: string, params: unknown[] = []): Promise<HanaStatementResult[]> {
    const result = await this.execRaw(sql, params);
    return Array.isArray(result) ? result : [];
  }

  private async getCurrentSchema(): Promise<string> {
    const row = await this.queryOne("SELECT CURRENT_SCHEMA AS SCHEMA_NAME FROM SYS.DUMMY");
    return (row?.SCHEMA_NAME as string) ?? "PUBLIC";
  }

  private async resolveSchema(schema?: string): Promise<string> {
    return schema ?? (await this.getCurrentSchema());
  }

  async getSchemas(): Promise<string[]> {
    return this.runExclusive(async () => {
      const rows = await this.queryAll("SELECT SCHEMA_NAME FROM SYS.SCHEMAS ORDER BY SCHEMA_NAME");
      return rows.map((row) => row.SCHEMA_NAME as string);
    });
  }

  async getDefaultSchema(): Promise<string | null> {
    return this.runExclusive(() => this.getCurrentSchema());
  }

  async getTables(schema?: string): Promise<string[]> {
    return this.runExclusive(async () => {
      const schemaToUse = await this.resolveSchema(schema);
      const rows = await this.queryAll(
        "SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ? ORDER BY TABLE_NAME",
        [schemaToUse]
      );
      return rows.map((row) => row.TABLE_NAME as string);
    });
  }

  async getViews(schema?: string): Promise<string[]> {
    return this.runExclusive(async () => {
      const schemaToUse = await this.resolveSchema(schema);
      const rows = await this.queryAll(
        "SELECT VIEW_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = ? ORDER BY VIEW_NAME",
        [schemaToUse]
      );
      return rows.map((row) => row.VIEW_NAME as string);
    });
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    return this.runExclusive(async () => {
      const schemaToUse = await this.resolveSchema(schema);
      const row = await this.queryOne(
        `SELECT
           (SELECT COUNT(*) FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?)
         + (SELECT COUNT(*) FROM SYS.VIEWS  WHERE SCHEMA_NAME = ? AND VIEW_NAME  = ?) AS CNT
         FROM SYS.DUMMY`,
        [schemaToUse, tableName, schemaToUse, tableName]
      );
      return Number(row?.CNT ?? 0) > 0;
    });
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    return this.runExclusive(async () => {
      const schemaToUse = await this.resolveSchema(schema);
      // Union table and view columns so the call works for either. HANA returns
      // uppercase result keys, so read them as such.
      const rows = await this.queryAll(
        `SELECT COLUMN_NAME, DATA_TYPE_NAME AS DATA_TYPE,
                CASE WHEN IS_NULLABLE = 'TRUE' THEN 'YES' ELSE 'NO' END AS IS_NULLABLE,
                DEFAULT_VALUE AS COLUMN_DEFAULT, COMMENTS AS DESCRIPTION, POSITION
         FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
         UNION ALL
         SELECT COLUMN_NAME, DATA_TYPE_NAME,
                CASE WHEN IS_NULLABLE = 'TRUE' THEN 'YES' ELSE 'NO' END,
                DEFAULT_VALUE, COMMENTS, POSITION
         FROM SYS.VIEW_COLUMNS WHERE SCHEMA_NAME = ? AND VIEW_NAME = ?
         ORDER BY POSITION`,
        [schemaToUse, tableName, schemaToUse, tableName]
      );
      return rows.map((row) => ({
        column_name: row.COLUMN_NAME as string,
        data_type: row.DATA_TYPE as string,
        is_nullable: row.IS_NULLABLE as string,
        column_default: (row.COLUMN_DEFAULT as string | null) ?? null,
        description: (row.DESCRIPTION as string | null) || null,
      }));
    });
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    return this.runExclusive(async () => {
      const schemaToUse = await this.resolveSchema(schema);
      // CONSTRAINT is reserved, so quote it; its value is e.g. 'PRIMARY KEY', 'UNIQUE'.
      const rows = await this.queryAll(
        `SELECT INDEX_NAME, COLUMN_NAME, "CONSTRAINT" AS CONSTRAINT_TYPE, POSITION
         FROM SYS.INDEX_COLUMNS
         WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
         ORDER BY INDEX_NAME, POSITION`,
        [schemaToUse, tableName]
      );

      const indexMap = new Map<string, { columns: string[]; is_unique: boolean; is_primary: boolean }>();
      for (const row of rows) {
        const indexName = row.INDEX_NAME as string;
        const constraint = ((row.CONSTRAINT_TYPE as string | null) ?? "").toUpperCase();
        const isPrimary = constraint.startsWith("PRIMARY");
        const isUnique = isPrimary || constraint.includes("UNIQUE");

        let info = indexMap.get(indexName);
        if (!info) {
          info = { columns: [], is_unique: isUnique, is_primary: isPrimary };
          indexMap.set(indexName, info);
        }
        info.columns.push(row.COLUMN_NAME as string);
      }

      return Array.from(indexMap.entries()).map(([index_name, info]) => ({
        index_name,
        column_names: info.columns,
        is_unique: info.is_unique,
        is_primary: info.is_primary,
      }));
    });
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    return this.runExclusive(async () => {
      try {
        const schemaToUse = await this.resolveSchema(schema);
        const row = await this.queryOne(
          `SELECT COMMENTS FROM (
             SELECT SCHEMA_NAME, TABLE_NAME AS OBJECT_NAME, COMMENTS FROM SYS.TABLES
             UNION ALL
             SELECT SCHEMA_NAME, VIEW_NAME, COMMENTS FROM SYS.VIEWS
           )
           WHERE SCHEMA_NAME = ? AND OBJECT_NAME = ?`,
          [schemaToUse, tableName]
        );
        return (row?.COMMENTS as string | null) || null;
      } catch {
        return null;
      }
    });
  }

  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    return this.runExclusive(async () => {
      try {
        const schemaToUse = await this.resolveSchema(schema);
        // Runtime statistics avoid a full COUNT(*).
        const row = await this.queryOne(
          "SELECT RECORD_COUNT FROM SYS.M_TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?",
          [schemaToUse, tableName]
        );
        if (row?.RECORD_COUNT === undefined || row?.RECORD_COUNT === null) return null;
        return Number(row.RECORD_COUNT);
      } catch {
        return null;
      }
    });
  }

  async getStoredProcedures(
    schema?: string,
    routineType?: "procedure" | "function"
  ): Promise<string[]> {
    return this.runExclusive(async () => {
      const schemaToUse = await this.resolveSchema(schema);
      const parts: string[] = [];
      if (routineType !== "function") {
        parts.push("SELECT PROCEDURE_NAME AS ROUTINE_NAME FROM SYS.PROCEDURES WHERE SCHEMA_NAME = ?");
      }
      if (routineType !== "procedure") {
        parts.push("SELECT FUNCTION_NAME AS ROUTINE_NAME FROM SYS.FUNCTIONS WHERE SCHEMA_NAME = ?");
      }
      const params = new Array(parts.length).fill(schemaToUse);
      const rows = await this.queryAll(`${parts.join(" UNION ALL ")} ORDER BY ROUTINE_NAME`, params);
      return rows.map((row) => row.ROUTINE_NAME as string);
    });
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    return this.runExclusive(async () => {
      const schemaToUse = await this.resolveSchema(schema);

      const procRow = await this.queryOne(
        "SELECT PROCEDURE_NAME, DEFINITION FROM SYS.PROCEDURES WHERE SCHEMA_NAME = ? AND PROCEDURE_NAME = ?",
        [schemaToUse, procedureName]
      );

      if (procRow) {
        const paramRows = await this.queryAll(
          `SELECT PARAMETER_NAME, DATA_TYPE_NAME, PARAMETER_TYPE
           FROM SYS.PROCEDURE_PARAMETERS
           WHERE SCHEMA_NAME = ? AND PROCEDURE_NAME = ?
           ORDER BY POSITION`,
          [schemaToUse, procedureName]
        );
        return {
          procedure_name: procRow.PROCEDURE_NAME as string,
          procedure_type: "procedure",
          language: "SQLSCRIPT",
          parameter_list: this.formatParameters(paramRows),
          definition: (procRow.DEFINITION as string | undefined) ?? undefined,
        };
      }

      const funcRow = await this.queryOne(
        "SELECT FUNCTION_NAME, DEFINITION FROM SYS.FUNCTIONS WHERE SCHEMA_NAME = ? AND FUNCTION_NAME = ?",
        [schemaToUse, procedureName]
      );

      if (funcRow) {
        const paramRows = await this.queryAll(
          `SELECT PARAMETER_NAME, DATA_TYPE_NAME, PARAMETER_TYPE
           FROM SYS.FUNCTION_PARAMETERS
           WHERE SCHEMA_NAME = ? AND FUNCTION_NAME = ?
           ORDER BY POSITION`,
          [schemaToUse, procedureName]
        );
        // HANA function params are IN/OUT/INOUT; the OUT ones are the return values.
        const mode = (row: HanaStatementResult) => ((row.PARAMETER_TYPE as string) ?? "IN").toUpperCase();
        const inputs = paramRows.filter((r) => mode(r) !== "OUT");
        const outputs = paramRows.filter((r) => mode(r) === "OUT");
        return {
          procedure_name: funcRow.FUNCTION_NAME as string,
          procedure_type: "function",
          language: "SQLSCRIPT",
          parameter_list: this.formatParameters(inputs),
          return_type: outputs.map((r) => r.DATA_TYPE_NAME as string).join(", ") || undefined,
          definition: (funcRow.DEFINITION as string | undefined) ?? undefined,
        };
      }

      throw new Error(`Stored procedure '${procedureName}' not found in schema '${schemaToUse}'`);
    });
  }

  private formatParameters(paramRows: HanaStatementResult[]): string {
    return paramRows
      .map((row) => {
        const mode = ((row.PARAMETER_TYPE as string) ?? "IN").toUpperCase();
        return `${row.PARAMETER_NAME} ${mode} ${row.DATA_TYPE_NAME}`;
      })
      .join(", ");
  }

  // SQLScript procedural DDL and anonymous DO blocks carry semicolons inside their
  // bodies, so submit them as one statement; split everything else on ';'.
  private splitStatements(sqlQuery: string): string[] {
    const stripped = stripCommentsAndStrings(sqlQuery, "hana");
    if (/\bbegin\b/i.test(stripped) || HanaConnector.PROCEDURAL_RE.test(stripped)) {
      const trimmed = sqlQuery.trim();
      return trimmed ? [trimmed] : [];
    }
    const parts = splitSQLStatements(sqlQuery, "hana");
    if (parts.length > 0) return parts;
    const trimmed = sqlQuery.trim();
    return trimmed ? [trimmed] : [];
  }

  // Cap rows for a read query, including CTEs and comment-prefixed SELECTs that
  // SQLRowLimiter (leading SELECT only) would miss.
  private capRows(sql: string, maxRows?: number): string {
    if (!maxRows) return sql;
    const firstKeyword = stripCommentsAndStrings(sql, "hana")
      .trimStart()
      .match(/^([a-z]+)/i)?.[1]
      ?.toLowerCase();
    if (firstKeyword === "select" && sql.trimStart().toLowerCase().startsWith("select")) {
      return SQLRowLimiter.applyMaxRows(sql, maxRows);
    }
    if (firstKeyword === "select" || firstKeyword === "with") {
      const inner = sql.trim().replace(/;\s*$/, "");
      return `SELECT * FROM (\n${inner}\n) AS DBHUB_LIMITED LIMIT ${maxRows}`;
    }
    return sql;
  }

  async executeSQL(sqlQuery: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    const statements = this.splitStatements(sqlQuery);

    // Positional parameters can't be spread across statements.
    if (parameters && parameters.length > 0 && statements.length > 1) {
      throw new Error(
        "Parameters are not supported with multiple statements; run parameterized statements one at a time."
      );
    }

    const processed = statements.map((stmt) => this.capRows(stmt, options.maxRows));

    return this.runExclusive(async () => {
      if (!this.connection) {
        throw new Error("Not connected to SAP HANA database");
      }
      if (options.readonly) {
        return this.executeReadOnly(processed, parameters);
      }
      return this.runStatements(processed, parameters);
    });
  }

  private async runStatements(statements: string[], parameters?: any[]): Promise<SQLResult> {
    const rows: any[] = [];
    let rowCount = 0;
    for (const statement of statements) {
      const result = await this.execRaw(statement, parameters ?? []);
      if (Array.isArray(result)) {
        rows.push(...result);
        rowCount += result.length;
      } else if (typeof result === "number") {
        rowCount += result;
      }
    }
    return { rows, rowCount };
  }

  // Engine-level read-only enforcement behind the keyword classifier. Marks the
  // transaction read-only, then always rolls back and restores READ WRITE +
  // autocommit so the shared connection stays usable; discards it if that fails.
  private async executeReadOnly(statements: string[], parameters?: any[]): Promise<SQLResult> {
    const connection = this.connection!;
    connection.setAutoCommit(false);
    try {
      await this.execRaw("SET TRANSACTION READ ONLY");
      return await this.runStatements(statements, parameters);
    } finally {
      await this.restoreReadWrite(connection);
    }
  }

  private async restoreReadWrite(connection: HanaConnection): Promise<void> {
    const rollback = () =>
      new Promise<void>((resolve, reject) => connection.rollback((e) => (e ? reject(e) : resolve())));
    try {
      await rollback();
      await this.execRaw("SET TRANSACTION READ WRITE");
      await rollback();
      connection.setAutoCommit(true);
    } catch {
      if (this.connection === connection) this.connection = undefined;
      await new Promise<void>((resolve) => {
        try {
          connection.disconnect(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }
}

const hanaConnector = new HanaConnector();
ConnectorRegistry.register(hanaConnector);
