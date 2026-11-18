import https from "node:https";
import {
  createClient,
  parseError,
  ClickHouseLogLevel,
  type ClickHouseClient,
  type ClickHouseSettings,
} from "@clickhouse/client";
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  SQLResultSet,
  DatabaseMessage,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
} from "../interface.js";
import { SafeURL, rawQueryParamValues } from "../../utils/safe-url.js";
import { obfuscateDSNPassword, getDefaultPortForType } from "../../utils/dsn-obfuscate.js";
import { splitSQLStatements } from "../../utils/sql-parser.js";
import { objectRows } from "../../utils/result-columns.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";
import { ClientQueryTimeoutError, clientQueryTimeoutMs } from "../../utils/query-timeout.js";
import { toClickHouseSettings } from "../../utils/session-settings.js";

/** `disable` is plain HTTP; `require` is HTTPS without certificate checks; `verify-full` checks chain and host name. */
export type ClickHouseSslMode = "disable" | "require" | "verify-full";

const SSL_MODES: readonly string[] = ["disable", "require", "verify-full"];

/** What the DSN parser hands to the connector. */
export interface ClickHouseConnectionConfig {
  /** Base URL of the server's HTTP interface, e.g. `http://localhost:8123` */
  url: string;
  username: string;
  password: string;
  database: string;
  sslmode: ClickHouseSslMode;
}

/**
 * ClickHouse DSN parser
 * Expected format: clickhouse://user:password@host:8123/database
 *
 * DBHub talks to ClickHouse over its HTTP interface, so the port is the HTTP
 * port (8123), or the HTTPS port (8443, the one ClickHouse Cloud exposes) when
 * `sslmode` is `require` or `verify-full`. The user defaults to `default` and
 * the database to `default`, as on the server.
 */
export class ClickHouseDSNParser implements DSNParser {
  async parse(dsn: string, _config?: ConnectorConfig): Promise<ClickHouseConnectionConfig> {
    if (!this.isValidDSN(dsn)) {
      throw new Error(
        `Invalid ClickHouse DSN format.\nProvided: ${obfuscateDSNPassword(dsn)}\nExpected: ${this.getSampleDSN()}`
      );
    }

    try {
      const url = new SafeURL(dsn);

      // Read from the raw query rather than SafeURL's parameters: SafeURL drops
      // a parameter with no value, so `?sslmode=` would otherwise look like no
      // sslmode at all and connect over plain HTTP. Every occurrence must be
      // valid; the last one applies.
      const sslmodes = rawQueryParamValues(dsn, "sslmode");
      for (const mode of sslmodes) {
        if (!SSL_MODES.includes(mode)) {
          throw new Error(
            `Unsupported sslmode '${mode}' for ClickHouse. Supported: ${SSL_MODES.join(", ")}`
          );
        }
      }
      const sslmode = (sslmodes.at(-1) ?? "disable") as ClickHouseSslMode;

      const host = url.hostname;
      if (!host) {
        throw new Error("ClickHouse DSN must include a host");
      }
      const port = url.port
        ? parseInt(url.port, 10)
        : getDefaultPortForType("clickhouse", sslmode);
      const scheme = sslmode === "disable" ? "http" : "https";

      return {
        // SafeURL hands back an IPv6 address without its brackets
        url: `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`,
        username: url.username || "default",
        password: url.password ?? "",
        database: (url.pathname ? url.pathname.substring(1) : "") || "default",
        sslmode,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse ClickHouse DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "clickhouse://default:password@localhost:8123/default?sslmode=disable";
  }

  isValidDSN(dsn: string): boolean {
    return dsn.startsWith("clickhouse://");
  }
}

/**
 * Row format every statement is read in: one JSON array per line, preceded by
 * a line of column names and a line of column types. Rows arrive positionally,
 * so two columns of the same name both survive (see result-columns.ts), and
 * line by line, so a `max_rows` cap can stop reading without parsing the rest.
 */
const ROW_FORMAT = "JSONCompactEachRowWithNamesAndTypes";

/**
 * Bytes of response the server holds back before it starts sending
 * (the HTTP interface's `buffer_size` parameter, which is not a setting and so
 * is accepted from read-only users too). A response that fits is sent only
 * once the statement has finished, which gives it two properties a streamed
 * response lacks: an error is reported as an HTTP error instead of being
 * appended to rows already sent, and the `X-ClickHouse-Summary` header holds
 * the final counters instead of the progress at the time of the first flush.
 */
const RESPONSE_BUFFER_BYTES = 1024 * 1024;

/** Largest delay a Node timer honours; used as "no client-side timeout". */
const NO_REQUEST_TIMEOUT_MS = 2_147_483_647;

/** What the HTTP client reports when its request timeout fires. */
const CLIENT_TIMEOUT_MESSAGE = "Timeout error.";

/** Engines whose rows come from a stored SELECT rather than stored data. */
const VIEW_ENGINES = "('View', 'MaterializedView', 'LiveView', 'WindowView')";

/** Longest piece of an unreadable response quoted back in an error. */
const MAX_ERROR_TEXT = 2000;

/**
 * Counters ClickHouse reports for a statement in the X-ClickHouse-Summary
 * response header. All values are decimal strings; newer servers add fields.
 */
interface QuerySummary {
  read_rows?: string;
  read_bytes?: string;
  written_rows?: string;
  written_bytes?: string;
  elapsed_ns?: string;
}

/**
 * JSON.parse reviver that keeps an integer too large for a double as its
 * source text. ClickHouse writes UInt64/Int64 as bare numbers unless
 * `output_format_json_quote_64bit_integers` is on (its default changed between
 * releases), and a plain JSON.parse would silently round e.g. a 64-bit id.
 */
function keepLargeIntegers(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
  ) {
    return context.source;
  }
  return value;
}

/**
 * Split a ClickHouse key expression (`primary_key`, `sorting_key`, a skipping
 * index's `expr`) into its top-level parts: `a, toDate(b), (c, d)` is three
 * parts. Commas inside parentheses, brackets or quoted names belong to a part.
 */
export function splitKeyExpression(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (quote) {
      if (ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
    } else if (ch === ")" || ch === "]") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(expression.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expression.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Turn text ClickHouse sent where a row was expected into the error it describes. */
function responseError(text: string): Error {
  const shown = text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}...` : text;
  const parsed = parseError(shown);
  return parsed instanceof Error ? parsed : new Error(shown);
}

/**
 * Parse one line of a ROW_FORMAT response into its array of values. Anything
 * else on a line is an error the server appended after it had started sending
 * rows: plain `Code: N. DB::Exception: ...` text, or `{"exception": "..."}`
 * when the server writes exceptions in the output format.
 */
function parseRowLine(text: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(text, keepLargeIntegers as (key: string, value: unknown) => unknown);
  } catch {
    throw responseError(text);
  }
  if (!Array.isArray(value)) {
    const exception = (value as { exception?: unknown } | null)?.exception;
    throw responseError(typeof exception === "string" ? exception : text);
  }
  return value;
}

/** Parse the X-ClickHouse-Summary header, tolerating its absence or a malformed value. */
function parseSummary(header: unknown): QuerySummary | undefined {
  if (typeof header !== "string") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(header);
    return typeof parsed === "object" && parsed !== null ? (parsed as QuerySummary) : undefined;
  } catch {
    return undefined;
  }
}

/** A summary counter as a number, 0 when absent or unreadable. */
function counter(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * One line describing what a statement cost the server, or undefined when it
 * neither read nor wrote rows (DDL, `SELECT 1`-style constants report nothing
 * worth a line).
 */
export function describeSummary(summary: QuerySummary): string | undefined {
  const parts: string[] = [];
  const readRows = counter(summary.read_rows);
  const writtenRows = counter(summary.written_rows);
  if (readRows > 0) {
    parts.push(`read ${readRows} rows (${counter(summary.read_bytes)} bytes)`);
  }
  if (writtenRows > 0) {
    parts.push(`wrote ${writtenRows} rows (${counter(summary.written_bytes)} bytes)`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  const elapsedNs = counter(summary.elapsed_ns);
  const elapsed = elapsedNs > 0 ? ` in ${(elapsedNs / 1e9).toFixed(3)}s` : "";
  const text = parts.join(", ") + elapsed;
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * ClickHouse connector, built on the official client's HTTP interface
 * (pure JavaScript, no native code).
 *
 * Schemas: a ClickHouse database is what DBHub calls a schema, as in MySQL.
 * Searches default to the database named in the DSN.
 *
 * Statelessness: every statement is its own HTTP request with no server-side
 * session, so `SET`, `USE` and temporary tables do not carry from one
 * statement to the next. Settings that should apply to every statement belong
 * in `[sources.session]`, which is sent with each request.
 *
 * Read-only: a read-only tool's statements are sent with `readonly = 1`, which
 * the server enforces itself: it rejects writes, DDL and settings changes, and
 * most table functions that reach outside the server. A user whose own
 * profile is already read-only cannot change settings at all (`readonly = 1`)
 * or cannot change `readonly` (`readonly = 2`); the connector detects that at
 * connect time and leaves enforcement to the profile.
 */
export class ClickHouseConnector implements Connector {
  id: ConnectorType = "clickhouse";
  name = "ClickHouse";
  dsnParser = new ClickHouseDSNParser();

  private client?: ClickHouseClient;
  /** Database named in the DSN, as the server resolved it at connect time */
  private defaultDatabase = "default";
  /** The connected user's own `readonly` setting: 0, 1 or 2 */
  private userReadonly = 0;
  /** Settings sent with every request, when the user may change settings */
  private baseSettings: ClickHouseSettings = {};
  /** Client-side request timeout, when query_timeout is configured */
  private requestTimeoutMs?: number;
  // Source ID is set by ConnectorManager after cloning
  private sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new ClickHouseConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      const parsed = await this.dsnParser.parse(dsn, config);
      const queryTimeoutMs =
        config?.queryTimeoutSeconds !== undefined
          ? Math.ceil(config.queryTimeoutSeconds * 1000)
          : undefined;
      // The client's request timeout counts socket inactivity, and a running
      // query sends nothing until it has rows, so without a query_timeout it
      // must not fire at all. With one, it trails the server-side limit (see
      // query-timeout.ts).
      this.requestTimeoutMs =
        queryTimeoutMs !== undefined ? clientQueryTimeoutMs(queryTimeoutMs) : undefined;

      this.client = createClient({
        url: parsed.url,
        username: parsed.username,
        password: parsed.password,
        database: parsed.database,
        application: "dbhub",
        request_timeout: this.requestTimeoutMs ?? NO_REQUEST_TIMEOUT_MS,
        // Failures are thrown to the caller; the client's own logging of them
        // would only repeat each one on stderr.
        log: { level: ClickHouseLogLevel.OFF },
        ...(config?.poolMaxConnections !== undefined && {
          max_open_connections: config.poolMaxConnections,
        }),
        // `require` encrypts without verifying the certificate, which the
        // client only allows through an agent of our own. `verify-full` is the
        // client's default HTTPS behaviour: chain and host name are checked.
        ...(parsed.sslmode === "require" && {
          http_agent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
        }),
      });

      // Smoke test, sent without any setting: whether this user may change
      // settings is one of the things it finds out.
      const probe = await this.probe(config?.connectionTimeoutSeconds);
      this.defaultDatabase = probe.database || parsed.database;
      this.userReadonly = probe.readonly;

      const sessionSettings = config?.sessionSettings;
      const hasSessionSettings =
        sessionSettings !== undefined && Object.keys(sessionSettings).length > 0;
      if (this.userReadonly === 1) {
        // A readonly=1 user may not change any setting, so nothing below can be sent.
        if (hasSessionSettings) {
          throw new Error(
            `ClickHouse user '${parsed.username}' is restricted to readonly = 1 and cannot change settings, ` +
              `so [sources.session] cannot be applied. Set these in the user's settings profile on the server instead.`
          );
        }
        if (queryTimeoutMs !== undefined) {
          console.error(
            `Source '${this.sourceId}': ClickHouse user '${parsed.username}' is restricted to readonly = 1, ` +
              `so query_timeout cannot be sent as max_execution_time. It applies on the client only.`
          );
        }
        this.baseSettings = {};
      } else {
        this.baseSettings = {
          // 64-bit integers as JSON numbers (keepLargeIntegers keeps the ones a
          // double cannot hold as text) and decimals as strings, whatever the
          // server's defaults, so results look the same on every version.
          output_format_json_quote_64bit_integers: 0,
          output_format_json_quote_decimals: 1,
          // Stop a read-only query when its request is dropped: a max_rows cap
          // that stops reading, or a client-side timeout.
          cancel_http_readonly_queries_on_client_close: 1,
          ...(queryTimeoutMs !== undefined && {
            max_execution_time: Math.ceil(queryTimeoutMs / 1000),
          }),
          ...(sessionSettings !== undefined && toClickHouseSettings(sessionSettings)),
        };
        // A setting the server does not know, or will not take from this user,
        // would otherwise fail every statement. Fail the connection instead,
        // with the server's error naming the setting.
        await this.catalog("SELECT 1");
      }

      if (initScript) {
        await this.executeSQL(initScript, {});
      }
    } catch (error) {
      // Close the client if it was created before the failure, otherwise its
      // keep-alive sockets outlive the failed attempt (see closeQuietly).
      await closeQuietly(() => this.disconnect());
      throw error;
    }
  }

  /**
   * First round trip: proves the credentials work and reads the database the
   * session landed in and the user's own `readonly` level. Bounded by
   * connection_timeout, reported the way a refused connection is.
   */
  private async probe(
    connectionTimeoutSeconds?: number
  ): Promise<{ database: string; readonly: number }> {
    const signal =
      connectionTimeoutSeconds !== undefined
        ? AbortSignal.timeout(connectionTimeoutSeconds * 1000)
        : undefined;
    try {
      const resultSet = await this.requireClient().query({
        query: "SELECT currentDatabase() AS database, toString(getSetting('readonly')) AS readonly",
        format: "JSONEachRow",
        abort_signal: signal,
      });
      const rows = await resultSet.json<{ database: string; readonly: string }>();
      return { database: rows[0]?.database ?? "", readonly: Number(rows[0]?.readonly ?? 0) || 0 };
    } catch (error) {
      if (signal?.aborted) {
        throw Object.assign(
          new Error(`Timed out connecting to ClickHouse after ${connectionTimeoutSeconds}s`),
          { code: "ETIMEDOUT", cause: error }
        );
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.client = undefined;
      await client.close();
    }
  }

  private requireClient(): ClickHouseClient {
    if (!this.client) {
      throw new Error("Not connected to ClickHouse database");
    }
    return this.client;
  }

  /**
   * Settings for one request. `readonly = 1` is added for a read-only tool
   * when the user is not read-only already: a readonly=2 user may not change
   * `readonly` (and is read-only without it), and a readonly=1 user may not
   * change anything, which is why baseSettings is empty for one.
   *
   * ClickHouse checks every setting of a request against the settings in
   * force before the request, so `readonly = 1` and the settings sent beside
   * it are accepted together.
   */
  private settingsFor(readonly: boolean | undefined): ClickHouseSettings {
    return {
      ...this.baseSettings,
      ...(readonly && this.userReadonly === 0 && { readonly: "1" }),
      buffer_size: String(RESPONSE_BUFFER_BYTES),
    };
  }

  /** Report the client's request timeout the way the other connectors report theirs. */
  private translateError(error: unknown): unknown {
    if (
      this.requestTimeoutMs !== undefined &&
      error instanceof Error &&
      error.message === CLIENT_TIMEOUT_MESSAGE
    ) {
      return new ClientQueryTimeoutError(this.requestTimeoutMs);
    }
    return error;
  }

  /** Run a catalog query, read-only, and return its rows as objects. */
  private async catalog<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
    try {
      const resultSet = await this.requireClient().query({
        query,
        format: "JSONEachRow",
        query_params: params,
        clickhouse_settings: this.settingsFor(true),
      });
      return await resultSet.json<T>();
    } catch (error) {
      throw this.translateError(error);
    }
  }

  private databaseOrDefault(schema?: string): string {
    return schema || this.defaultDatabase;
  }

  async getSchemas(): Promise<string[]> {
    // A database is a schema here. System databases are left out, as the other
    // connectors leave out pg_catalog and performance_schema.
    const rows = await this.catalog<{ name: string }>(
      `SELECT name FROM system.databases
       WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
       ORDER BY name`
    );
    return rows.map((row) => row.name);
  }

  async getDefaultSchema(): Promise<string | null> {
    return this.defaultDatabase;
  }

  async getTables(schema?: string): Promise<string[]> {
    const rows = await this.catalog<{ name: string }>(
      `SELECT name FROM system.tables
       WHERE database = {database:String} AND engine NOT IN ${VIEW_ENGINES} AND is_temporary = 0
       ORDER BY name`,
      { database: this.databaseOrDefault(schema) }
    );
    return rows.map((row) => row.name);
  }

  async getViews(schema?: string): Promise<string[]> {
    // Materialized views are listed with the plain ones: both are defined by a
    // SELECT, which is what a caller browsing views is after.
    const rows = await this.catalog<{ name: string }>(
      `SELECT name FROM system.tables
       WHERE database = {database:String} AND engine IN ${VIEW_ENGINES}
       ORDER BY name`,
      { database: this.databaseOrDefault(schema) }
    );
    return rows.map((row) => row.name);
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    const rows = await this.catalog<{
      name: string;
      type: string;
      default_kind: string;
      default_expression: string;
      comment: string;
    }>(
      `SELECT name, type, default_kind, default_expression, comment FROM system.columns
       WHERE database = {database:String} AND table = {table:String}
       ORDER BY position`,
      { database: this.databaseOrDefault(schema), table: tableName }
    );
    return rows.map((row) => ({
      column_name: row.name,
      data_type: row.type,
      // Nullability is part of the type: Nullable(T), or LowCardinality(Nullable(T)).
      is_nullable: /^(?:LowCardinality\()?Nullable\(/.test(row.type) ? "YES" : "NO",
      column_default: ClickHouseConnector.formatDefault(row.default_kind, row.default_expression),
      description: row.comment || null,
    }));
  }

  /**
   * A column's default as its DDL shows it. MATERIALIZED, ALIAS and EPHEMERAL
   * keep their keyword: such a column is computed, and (unlike DEFAULT) is
   * left out of `SELECT *`.
   */
  private static formatDefault(kind: string, expression: string): string | null {
    if (!kind) {
      return null;
    }
    return kind === "DEFAULT" ? expression : `${kind} ${expression}`.trim();
  }

  /**
   * ClickHouse has no unique indexes. What it has is reported in their place,
   * none of it marked unique:
   * - `PRIMARY KEY`: the sparse index a MergeTree table is read through,
   * - `ORDER BY`: the sorting key, when it has more columns than the primary key,
   * - each data-skipping index, under its own name.
   * A "column" may be an expression such as `toDate(ts)`.
   */
  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    const params = { database: this.databaseOrDefault(schema), table: tableName };
    const [tables, skipping] = await Promise.all([
      this.catalog<{ primary_key: string; sorting_key: string }>(
        `SELECT primary_key, sorting_key FROM system.tables
         WHERE database = {database:String} AND name = {table:String}`,
        params
      ),
      this.catalog<{ name: string; expr: string }>(
        `SELECT name, expr FROM system.data_skipping_indices
         WHERE database = {database:String} AND table = {table:String}
         ORDER BY name`,
        params
      ),
    ]);

    const indexes: TableIndex[] = [];
    const primaryKey = splitKeyExpression(tables[0]?.primary_key ?? "");
    const sortingKey = splitKeyExpression(tables[0]?.sorting_key ?? "");
    if (primaryKey.length > 0) {
      indexes.push({
        index_name: "PRIMARY KEY",
        column_names: primaryKey,
        is_unique: false,
        is_primary: true,
      });
    }
    if (sortingKey.length > 0 && sortingKey.join(",") !== primaryKey.join(",")) {
      indexes.push({
        index_name: "ORDER BY",
        column_names: sortingKey,
        is_unique: false,
        is_primary: false,
      });
    }
    for (const index of skipping) {
      indexes.push({
        index_name: index.name,
        column_names: splitKeyExpression(index.expr),
        is_unique: false,
        is_primary: false,
      });
    }
    return indexes;
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    const rows = await this.catalog<{ comment: string }>(
      `SELECT comment FROM system.tables
       WHERE database = {database:String} AND name = {table:String}`,
      { database: this.databaseOrDefault(schema), table: tableName }
    );
    return rows[0]?.comment || null;
  }

  async getTableRowCount(tableName: string, schema?: string): Promise<number | null> {
    // total_rows is exact for MergeTree tables and NULL where the engine does
    // not track it (views, Distributed, most integration engines).
    const rows = await this.catalog<{ total_rows: string | number | null }>(
      `SELECT total_rows FROM system.tables
       WHERE database = {database:String} AND name = {table:String}`,
      { database: this.databaseOrDefault(schema), table: tableName }
    );
    const totalRows = rows[0]?.total_rows;
    return totalRows === null || totalRows === undefined ? null : Number(totalRows);
  }

  /**
   * ClickHouse has no stored procedures. Its SQL user-defined functions are
   * reported as functions; they are server-wide, so the same list is returned
   * whatever the schema.
   */
  async getStoredProcedures(
    _schema?: string,
    routineType?: "procedure" | "function"
  ): Promise<string[]> {
    if (routineType === "procedure") {
      return [];
    }
    const rows = await this.catalog<{ name: string }>(
      `SELECT name FROM system.functions WHERE origin = 'SQLUserDefined' ORDER BY name`
    );
    return rows.map((row) => row.name);
  }

  async getStoredProcedureDetail(procedureName: string, _schema?: string): Promise<StoredProcedure> {
    const rows = await this.catalog<{ name: string; create_query: string }>(
      `SELECT name, create_query FROM system.functions
       WHERE origin = 'SQLUserDefined' AND name = {name:String}`,
      { name: procedureName }
    );
    if (rows.length === 0) {
      throw new Error(`Function '${procedureName}' not found`);
    }
    // CREATE FUNCTION f AS (a, b) -> expression   or   ... AS a -> expression
    const parameters = /\bAS\s+(?:\(([^)]*)\)|([A-Za-z_]\w*))\s*->/i.exec(rows[0].create_query);
    return {
      procedure_name: rows[0].name,
      procedure_type: "function",
      language: "sql",
      parameter_list: (parameters?.[1] ?? parameters?.[2] ?? "").trim(),
      definition: rows[0].create_query,
    };
  }

  /**
   * Run a batch: one HTTP request per statement, in order, stopping at the
   * first failure. Positional `parameters` bind to `{p1:Type}`, `{p2:Type}`,
   * ... placeholders (see parameter-mapper.ts).
   */
  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    const client = this.requireClient();
    const statements = splitSQLStatements(sql, "clickhouse");
    const queryParams =
      parameters && parameters.length > 0
        ? Object.fromEntries(parameters.map((value, index) => [`p${index + 1}`, value]))
        : undefined;

    const resultSets: SQLResultSet[] = [];
    const messages: DatabaseMessage[] = [];
    for (const [index, statement] of statements.entries()) {
      const { resultSet, summary } = await this.runStatement(client, statement, options, queryParams);
      resultSets.push(resultSet);
      const cost = summary && describeSummary(summary);
      if (cost) {
        messages.push({
          text: statements.length > 1 ? `Statement ${index + 1}: ${cost}` : cost,
        });
      }
    }
    return { resultSets, ...(messages.length > 0 && { messages }) };
  }

  /**
   * Run one statement and read its rows.
   *
   * The row cap is applied by reading: rows are taken off the response a line
   * at a time, and once `maxRows` are held and one more arrives, the response
   * is closed and the result marked truncated. The statement is sent exactly
   * as written, with no LIMIT spliced in, so the cap is right for every form
   * of query (LIMIT BY, WITH TIES, trailing SETTINGS, SHOW, DESCRIBE, ...).
   *
   * The returned summary is only present when it is known to be final: the
   * whole response was read and it fit the server's buffer (see
   * RESPONSE_BUFFER_BYTES).
   */
  private async runStatement(
    client: ClickHouseClient,
    statement: string,
    options: ExecuteOptions,
    queryParams: Record<string, unknown> | undefined
  ): Promise<{ resultSet: SQLResultSet; summary?: QuerySummary }> {
    const maxRows = options.maxRows;
    let columnNames: string[] | undefined;
    let typesSeen = false;
    const rows: unknown[][] = [];
    let truncated = false;
    let bytes = 0;
    let summary: QuerySummary | undefined;

    try {
      const response = await client.query({
        query: statement,
        format: ROW_FORMAT,
        query_params: queryParams,
        clickhouse_settings: this.settingsFor(options.readonly),
      });
      summary = parseSummary(response.response_headers["x-clickhouse-summary"]);
      try {
        reading: for await (const lines of response.stream()) {
          for (const line of lines as Array<{ text: string }>) {
            bytes += Buffer.byteLength(line.text) + 1;
            const values = parseRowLine(line.text);
            if (columnNames === undefined) {
              columnNames = values.map(String);
            } else if (!typesSeen) {
              typesSeen = true;
            } else if (values.length !== columnNames.length) {
              // Not a row of this result: a server that writes exceptions in
              // the output format sends one as a single-string array.
              throw responseError(
                values.length === 1 && typeof values[0] === "string" ? values[0] : line.text
              );
            } else if (maxRows && rows.length >= maxRows) {
              truncated = true;
              break reading;
            } else {
              rows.push(values);
            }
          }
        }
      } finally {
        // Releases the socket when reading stopped early; a no-op otherwise.
        response.close();
      }
    } catch (error) {
      throw this.translateError(error);
    }

    const summaryIsFinal = !truncated && bytes < RESPONSE_BUFFER_BYTES;
    const resultSet: SQLResultSet = {
      sql: statement,
      rows: columnNames ? objectRows(columnNames, rows) : [],
      // A statement with no result (INSERT ... SELECT, DDL) reports what it wrote.
      rowCount: columnNames ? rows.length : counter(summary?.written_rows),
      ...(truncated && { truncated: true }),
    };
    return { resultSet, ...(summaryIsFinal && summary && { summary }) };
  }
}

// Create and register the connector
const clickhouseConnector = new ClickHouseConnector();
ConnectorRegistry.register(clickhouseConnector);
