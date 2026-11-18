import https from "node:https";
import {
  createClient,
  parseError,
  ClickHouseError,
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
  HealthCheckResult,
} from "../interface.js";
import { computeHitRatioPct } from "../health-check-utils.js";
import { SafeURL, rawQueryParamValues } from "../../utils/safe-url.js";
import { obfuscateDSNPassword, getDefaultPortForType } from "../../utils/dsn-obfuscate.js";
import { splitSQLStatements, stripCommentsAndStrings } from "../../utils/sql-parser.js";
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

/**
 * Largest delay a Node timer honours. The client's own request timeout counts
 * socket inactivity, which neither bounds a query that keeps sending rows nor
 * tolerates one that computes for a while before its first row, so it is
 * switched off with this value and Deadline bounds elapsed time instead.
 */
const NO_REQUEST_TIMEOUT_MS = 2_147_483_647;

/**
 * Setting that makes the server report an error raised after it has started
 * sending rows as one more row of the output format, a one-string array in
 * ROW_FORMAT, which a single-column result cannot tell from data. Sent as 0
 * wherever settings can be sent, so such an error arrives as text no row can
 * be mistaken for.
 */
const EXCEPTION_IN_FORMAT_SETTING = "http_write_exception_in_output_format";

/** Engines whose rows come from a stored SELECT rather than stored data. */
const VIEW_ENGINES = "('View', 'MaterializedView', 'LiveView', 'WindowView')";

/** Longest piece of an unreadable response quoted back in an error. */
const MAX_ERROR_TEXT = 2000;

/**
 * The `system.metrics` gauges that count client connections, one per protocol.
 * `InterserverConnection` (replicas fetching parts) is left out: it is not a
 * client.
 */
const CLIENT_CONNECTION_METRICS =
  "('TCPConnection', 'HTTPConnection', 'MySQLConnection', 'PostgreSQLConnection')";

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
 * JSON.parse reviver that keeps a number a double cannot hold exactly as its
 * source text. ClickHouse writes 64-bit integers and decimals as bare numbers
 * unless the output settings quote them, which a user restricted to
 * `readonly = 1` cannot ask for, and a plain JSON.parse would silently round
 * a 64-bit id or a Decimal(38, 2) amount.
 *
 * A literal is exact when the double it parses to prints back as the same
 * digits. Floats pass, since ClickHouse writes them in the shortest form that
 * round-trips, as JavaScript does; exponent notation is only ever a float.
 */
export function keepExactNumbers(
  _key: string,
  value: unknown,
  context?: { source?: string }
): unknown {
  const source = context?.source;
  if (typeof value !== "number" || source === undefined || !/^-?\d+(?:\.\d+)?$/.test(source)) {
    return value;
  }
  // 1.50 and 1.5 are the same number; so are -0.0 and 0.
  const digits = source.includes(".") ? source.replace(/\.?0+$/, "") : source;
  return digits === String(value) || value === 0 ? value : source;
}

/** A type with its `Nullable(...)` and `LowCardinality(...)` wrappers removed. */
function unwrapType(type: string): string {
  const wrapped = /^(?:LowCardinality|Nullable)\((.*)\)$/s.exec(type);
  return wrapped ? unwrapType(wrapped[1]) : type;
}

/** Whether a column of this type can hold arbitrary text, such as the text of an error. */
function holdsFreeText(type: string): boolean {
  return /^(?:String|FixedString|Enum|Variant|Dynamic|JSON|Object)/.test(unwrapType(type));
}

/** Whether a row is a single string that reads as a ClickHouse error message. */
function isErrorMessageRow(values: unknown[]): values is [string] {
  return (
    values.length === 1 &&
    typeof values[0] === "string" &&
    parseError(values[0]) instanceof ClickHouseError
  );
}

/**
 * Whether a statement carries a `SETTINGS` clause, at any depth. Matched on
 * the statement with comments, strings and quoted names blanked, so a quoted
 * setting name (`SETTINGS \`max_threads\` = 1`) counts and the `system.settings`
 * table does not.
 */
export function hasSettingsClause(statement: string): boolean {
  return /\bsettings\b\s*(?:[a-z_][\w.]*\s*)?=/i.test(
    stripCommentsAndStrings(statement, "clickhouse")
  );
}

/**
 * An elapsed-time limit on one request, from sending it to reading the last
 * of its response. Passing the deadline aborts the request and, once the
 * response is being read, closes it.
 */
class Deadline {
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private closeResponse?: () => void;
  expired = false;

  constructor(private readonly timeoutMs: number | undefined) {
    if (timeoutMs !== undefined) {
      this.timer = setTimeout(() => {
        this.expired = true;
        this.controller.abort();
        this.closeResponse?.();
      }, timeoutMs);
    }
  }

  /** Signal for the request; undefined when there is no limit. */
  get signal(): AbortSignal | undefined {
    return this.timeoutMs === undefined ? undefined : this.controller.signal;
  }

  /** Register how to stop reading the response the request produced. */
  whileReading(close: () => void): void {
    this.closeResponse = close;
    if (this.expired) {
      close();
    }
  }

  /** The error to report for `error`: the timeout, when that is what ended the request. */
  explain(error: unknown): unknown {
    return this.expired ? new ClientQueryTimeoutError(this.timeoutMs!) : error;
  }

  clear(): void {
    clearTimeout(this.timer);
  }
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
 * Parse one line of a ROW_FORMAT response into its array of values, or
 * undefined when the line is not JSON. Such a line starts an error the server
 * appended after it had started sending rows, as text that runs to the end of
 * the response: `Code: N. DB::Exception: ...` on its own, or between
 * `__exception__` marker lines, depending on the server's version. An object
 * is `{"exception": "..."}`, the same error written in the output format.
 */
function parseRowLine(text: string): unknown[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text, keepExactNumbers as (key: string, value: unknown) => unknown);
  } catch {
    return undefined;
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
  /** Client-side limit on a request's elapsed time, when query_timeout is configured */
  private clientDeadlineMs?: number;
  /**
   * Whether the server may report an error as a row of the result (see
   * EXCEPTION_IN_FORMAT_SETTING). False wherever the connector could turn that
   * off; it can stay true only for a user restricted to `readonly = 1`.
   */
  private errorsAsRows = false;
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
      // The client-side deadline trails the server-side limit (see
      // query-timeout.ts). It is the only limit for a user who cannot be sent
      // max_execution_time.
      this.clientDeadlineMs =
        queryTimeoutMs !== undefined ? clientQueryTimeoutMs(queryTimeoutMs) : undefined;

      this.client = createClient({
        url: parsed.url,
        username: parsed.username,
        password: parsed.password,
        database: parsed.database,
        application: "dbhub",
        request_timeout: NO_REQUEST_TIMEOUT_MS,
        // Failures are thrown to the caller; the client's own logging of them
        // would only repeat each one on stderr.
        log: { level: ClickHouseLogLevel.OFF },
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
        this.errorsAsRows = await this.profileWritesErrorsAsRows();
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
          [EXCEPTION_IN_FORMAT_SETTING]: 0,
        };
        this.errorsAsRows = false;
        // A setting the server does not know, or will not take from this user,
        // would otherwise fail every statement. Fail the connection instead,
        // with the server's error naming the setting.
        try {
          await this.catalog("SELECT 1");
        } catch (error) {
          // A server from before the setting existed never writes an error as
          // a row, so there is nothing to turn off: go on without it.
          if (!ClickHouseConnector.isUnknownSetting(error, EXCEPTION_IN_FORMAT_SETTING)) {
            throw error;
          }
          delete this.baseSettings[EXCEPTION_IN_FORMAT_SETTING];
          await this.catalog("SELECT 1");
        }
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

  private static isUnknownSetting(error: unknown, setting: string): boolean {
    return (
      error instanceof ClickHouseError &&
      error.type === "UNKNOWN_SETTING" &&
      error.message.includes(setting)
    );
  }

  /**
   * For a user who cannot change settings: whether their profile has the
   * server write errors as rows. Anything short of a clear "no" counts as
   * yes, which only costs the extra scrutiny runStatement gives a last row.
   */
  private async profileWritesErrorsAsRows(): Promise<boolean> {
    try {
      const rows = await this.catalog<{ value: string }>(
        "SELECT value FROM system.settings WHERE name = {name:String}",
        { name: EXCEPTION_IN_FORMAT_SETTING }
      );
      // No such setting: a server from before it existed.
      return rows.length > 0 && rows[0].value !== "0";
    } catch {
      return true;
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

  /** Run a catalog query, read-only, and return its rows as objects. */
  private async catalog<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const deadline = new Deadline(this.clientDeadlineMs);
    try {
      const resultSet = await this.requireClient().query({
        query,
        format: "JSONEachRow",
        query_params: params,
        clickhouse_settings: this.settingsFor(true),
        abort_signal: deadline.signal,
      });
      deadline.whileReading(() => resultSet.close());
      return await resultSet.json<T>();
    } catch (error) {
      throw deadline.explain(error);
    } finally {
      deadline.clear();
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
   * Health metrics, from the server's own counters.
   *
   * Connections: `system.metrics` counts client connections per protocol and
   * `system.processes` lists the queries running. The server counts an HTTP
   * connection only while it is handling a request, so `idle` is in practice
   * the native-protocol clients with no query running: a kept-alive HTTP
   * connection between two requests is counted nowhere. ClickHouse has no
   * transaction a session could sit idle in.
   *
   * Cache: ClickHouse has no buffer pool. Table data is read through the
   * operating system's page cache, which the server keeps no hit counters
   * for. What it does cache and count for every MergeTree read is marks (the
   * offsets that turn a primary key range into file positions), so the mark
   * cache is what `bufferCache` reports, with a note saying so.
   *
   * Every table read here needs its own SELECT grant on servers where system
   * tables are not open to all users (`select_from_system_db_requires_grant`,
   * on in the configuration ClickHouse ships). What a missing grant hides is
   * left out and named in a note.
   *
   * The queries run one after the other, not together, so that this check is
   * one connection and one query at any moment: the one that is subtracted.
   */
  async getHealthCheck(): Promise<HealthCheckResult> {
    const denied: string[] = [];
    /** Rows of a system table, or undefined when the user may not read it. */
    const read = async <T>(table: string, query: string): Promise<T[] | undefined> => {
      try {
        return await this.catalog<T>(query);
      } catch (error) {
        if (error instanceof ClickHouseError && error.type === "ACCESS_DENIED") {
          denied.push(table);
          return undefined;
        }
        throw error;
      }
    };

    const metrics = await read<{ connections: number | string }>(
      "system.metrics",
      `SELECT sum(value) AS connections FROM system.metrics WHERE metric IN ${CLIENT_CONNECTION_METRICS}`
    );
    const processes = await read<{ active: number | string; longest_seconds: number }>(
      "system.processes",
      `SELECT count() AS active, max(elapsed) AS longest_seconds FROM system.processes
       WHERE query_id != queryID()`
    );
    let serverSettings: Array<{ value: string }> | undefined;
    try {
      serverSettings = await read<{ value: string }>(
        "system.server_settings",
        `SELECT value FROM system.server_settings WHERE name = 'max_connections'`
      );
    } catch (error) {
      // A server from before the table existed: the ceiling is not known.
      if (!(error instanceof ClickHouseError && error.type === "UNKNOWN_TABLE")) {
        throw error;
      }
      serverSettings = [];
    }
    // An event that has not happened yet has no row.
    const events = await read<{ event: string; value: number | string }>(
      "system.events",
      `SELECT event, value FROM system.events WHERE event IN ('MarkCacheHits', 'MarkCacheMisses')`
    );

    const result: HealthCheckResult = {};
    const notes: string[] = [];
    const notReported: string[] = [];

    if (metrics && processes) {
      // Less the connection this check itself is made over.
      const total = Math.max(0, Number(metrics[0]?.connections ?? 0) - 1);
      const active = Number(processes[0]?.active ?? 0);
      const maxConnections = Number(serverSettings?.[0]?.value);
      result.connections = {
        total,
        active,
        // The two counts are read by separate requests, and a query need not
        // belong to a counted connection (see above), hence the floor.
        idle: Math.max(0, total - active),
        idleInTransaction: 0,
        maxConnections: Number.isFinite(maxConnections) && maxConnections > 0 ? maxConnections : null,
        longestIdleInTransactionSeconds: null,
        // max() over no rows is 0, not NULL.
        longestActiveQuerySeconds: active > 0 ? Number(processes[0].longest_seconds) : null,
      };
      if (serverSettings === undefined) {
        notReported.push("max_connections");
      }
    } else {
      notReported.push("connections");
    }

    if (events) {
      const counts = Object.fromEntries(events.map((row) => [row.event, Number(row.value)]));
      const hits = counts.MarkCacheHits ?? 0;
      const misses = counts.MarkCacheMisses ?? 0;
      result.bufferCache = {
        hitRatioPct: computeHitRatioPct(hits + misses, misses),
        blocksHit: hits,
        blocksRead: misses,
      };
      notes.push(
        "buffer_cache is the mark cache: lookups of MergeTree marks served from memory (blocks_hit) or loaded from disk (blocks_read) since the server started. ClickHouse has no buffer pool; table data is cached by the operating system."
      );
    } else {
      notReported.push("buffer_cache");
    }

    if (denied.length > 0) {
      notes.unshift(
        `Connected user lacks the SELECT grant on ${denied.join(", ")}: ${notReported.join(" and ")} ${notReported.length > 1 ? "are" : "is"} not reported.`
      );
    }
    return { ...result, ...(notes.length > 0 && { notes }) };
  }

  /**
   * Run a batch: one HTTP request per statement, in order, stopping at the
   * first failure. Positional `parameters` bind to `{p1:Type}`, `{p2:Type}`,
   * ... placeholders (see parameter-mapper.ts).
   */
  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    const client = this.requireClient();
    const statements = splitSQLStatements(sql, "clickhouse");
    // Under `readonly = 1` the server refuses a statement that changes
    // settings. A user whose own profile is `readonly = 2` cannot be sent that
    // setting and may change others, so the same refusal is made here: without
    // it a read-only statement could lift the limits [sources.session] sets.
    if (options.readonly && this.userReadonly === 2 && statements.some(hasSettingsClause)) {
      throw new Error(
        "Read-only mode: a SETTINGS clause is not allowed, as it could override the limits configured for this source"
      );
    }
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
    let columnTypes: string[] | undefined;
    const rows: unknown[][] = [];
    // Widened: it is set inside `accept`, which narrowing does not follow.
    let truncated = false as boolean;
    let bytes = 0;
    let summary: QuerySummary | undefined;
    // A row that reads as an error message, held back until the next line
    // shows it was data or the end of the response shows it was the last.
    let heldBack: [string] | undefined;
    // Text of an error the server appended in place of further rows: every
    // line from the first that is not a row to the end of the response.
    let appendedError: string | undefined;

    /** Take a row into the result; false once the cap says to stop reading. */
    const accept = (values: unknown[]): boolean => {
      if (maxRows && rows.length >= maxRows) {
        truncated = true;
        return false;
      }
      rows.push(values);
      return true;
    };

    const deadline = new Deadline(this.clientDeadlineMs);
    try {
      const response = await client.query({
        query: statement,
        format: ROW_FORMAT,
        query_params: queryParams,
        clickhouse_settings: this.settingsFor(options.readonly),
        abort_signal: deadline.signal,
      });
      deadline.whileReading(() => response.close());
      summary = parseSummary(response.response_headers["x-clickhouse-summary"]);
      try {
        reading: for await (const lines of response.stream()) {
          for (const line of lines as Array<{ text: string }>) {
            bytes += Buffer.byteLength(line.text) + 1;
            const values = appendedError === undefined ? parseRowLine(line.text) : undefined;
            if (values === undefined) {
              // The message may be several lines in; it is read out of the
              // whole once the response ends. Capped, as only its head is shown.
              if ((appendedError?.length ?? 0) < MAX_ERROR_TEXT) {
                appendedError = `${appendedError ?? ""}${line.text}\n`;
              }
              continue;
            }
            if (columnNames === undefined) {
              columnNames = values.map(String);
              continue;
            }
            if (columnTypes === undefined) {
              columnTypes = values.map(String);
              continue;
            }
            if (values.length !== columnNames.length) {
              // Not a row of this result: an error written as a row is a
              // single string, whatever the number of columns.
              throw responseError(isErrorMessageRow(values) ? values[0] : line.text);
            }
            if (heldBack !== undefined) {
              const wasData = heldBack;
              heldBack = undefined;
              if (!accept(wasData)) {
                break reading;
              }
            }
            if (this.errorsAsRows && isErrorMessageRow(values)) {
              heldBack = values;
            } else if (!accept(values)) {
              break reading;
            }
          }
        }
      } catch (error) {
        // A server may drop the connection once it has written its error:
        // the error it wrote is the one to report, not the dropped connection.
        if (appendedError === undefined || deadline.expired) {
          throw error;
        }
      } finally {
        // Releases the socket when reading stopped early; a no-op otherwise.
        response.close();
      }
      if (appendedError !== undefined) {
        throw responseError(appendedError.trim());
      }
      if (heldBack !== undefined && !truncated) {
        // The response ended on a one-string row that reads as an error, from
        // a server that writes errors as rows. It is the error when the column
        // could not hold such text, or when the response had outgrown the
        // server's buffer: an error raised before that point is sent as an
        // HTTP error instead, so a row this early is data.
        const isError =
          !holdsFreeText(columnTypes?.[0] ?? "") || bytes >= RESPONSE_BUFFER_BYTES;
        if (isError) {
          throw responseError(heldBack[0]);
        }
        accept(heldBack);
      }
    } catch (error) {
      throw deadline.explain(error);
    } finally {
      deadline.clear();
    }

    // Decimal columns as text for every user: a server that could not be told
    // to quote them sends bare numbers, of which keepExactNumbers has already
    // kept the inexact ones as text.
    columnTypes?.forEach((type, column) => {
      if (unwrapType(type).startsWith("Decimal")) {
        for (const row of rows) {
          if (typeof row[column] === "number") {
            row[column] = String(row[column]);
          }
        }
      }
    });

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
