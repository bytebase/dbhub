import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ClickHouseConnector,
  describeSummary,
  splitKeyExpression,
} from '../clickhouse/index.js';
import type { ConnectorConfig } from '../interface.js';

// The client-side deadline normally trails query_timeout by several seconds
// (see query-timeout.ts); shortened so the timeout test does not wait for it.
vi.mock('../../utils/query-timeout.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/query-timeout.js')>()),
  clientQueryTimeoutMs: () => 200,
}));

/** One request as the fake server saw it. */
interface SeenRequest {
  params: URLSearchParams;
  body: string;
}

/** What the fake server answers a statement with. */
interface FakeResponse {
  status?: number;
  /** Response body. For a result: names line, types line, then one JSON array per row. */
  body?: string;
  summary?: Record<string, string>;
  /** Overrides the X-ClickHouse-Format header (default: the format the request asked for). */
  format?: string;
}

/** Body of a ROW_FORMAT result. */
function result(names: string[], types: string[], rows: unknown[][]): string {
  return [names, types, ...rows].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

/**
 * A stand-in for ClickHouse's HTTP interface: answers the connect probe with
 * the given `readonly` level and every other statement through `respond`.
 */
class FakeClickHouse {
  readonly requests: SeenRequest[] = [];
  /** The `readonly` level the connected user reports. */
  readonly = '0';
  respond: (request: SeenRequest) => FakeResponse = () => ({});
  private readonly server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const seen: SeenRequest = {
        params: new URL(req.url ?? '/', 'http://localhost').searchParams,
        body: Buffer.concat(chunks).toString(),
      };
      this.requests.push(seen);
      const format = seen.params.get('default_format') ?? 'TabSeparated';
      if (seen.body.includes("getSetting('readonly')")) {
        res.writeHead(200, { 'X-ClickHouse-Format': format });
        res.end(JSON.stringify({ database: 'analytics', readonly: this.readonly }) + '\n');
        return;
      }
      const response = this.respond(seen);
      res.writeHead(response.status ?? 200, {
        'X-ClickHouse-Format': response.format ?? format,
        ...(response.summary && { 'X-ClickHouse-Summary': JSON.stringify(response.summary) }),
      });
      res.end(response.body ?? '');
    });
  });

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `clickhouse://reader:secret@127.0.0.1:${port}/analytics`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** How many requests connect() made: its probe and its settings check. */
  connectRequests = 0;

  /** Requests made after connect(). */
  get statements(): SeenRequest[] {
    return this.requests.slice(this.connectRequests);
  }
}

describe('ClickHouseConnector', () => {
  let fake: FakeClickHouse;
  let connector: ClickHouseConnector;
  let dsn: string;

  beforeEach(async () => {
    fake = new FakeClickHouse();
    dsn = await fake.start();
    connector = new ClickHouseConnector();
  });

  afterEach(async () => {
    await connector.disconnect();
    await fake.stop();
    vi.restoreAllMocks();
  });

  const connect = async (config?: ConnectorConfig) => {
    await connector.connect(dsn, undefined, config);
    fake.connectRequests = fake.requests.length;
  };

  describe('connect', () => {
    it('probes without sending any setting and adopts the session database', async () => {
      await connect({ queryTimeoutSeconds: 30, sessionSettings: { max_rows_to_read: 1000 } });

      const probe = fake.requests[0];
      expect([...probe.params.keys()].sort()).toEqual(['database', 'default_format', 'query_id']);
      expect(await connector.getDefaultSchema()).toBe('analytics');
    });

    it('checks the settings it will send before reporting the connection as up', async () => {
      fake.respond = ({ params }) =>
        params.has('no_such_setting')
          ? { status: 400, body: "Code: 115. DB::Exception: Setting no_such_setting is neither a builtin setting nor started with the prefix 'custom_' registered for user-defined settings. (UNKNOWN_SETTING)" }
          : {};

      await expect(connect({ sessionSettings: { no_such_setting: 1 } })).rejects.toMatchObject({
        code: '115',
        type: 'UNKNOWN_SETTING',
      });

      await connect({ sessionSettings: { max_rows_to_read: 1000 } });
      const check = fake.requests.at(-1)!;
      expect(check.body).toBe('SELECT 1');
      expect(check.params.get('max_rows_to_read')).toBe('1000');
      expect(check.params.get('readonly')).toBe('1');
    });

    it('authenticates with the DSN credentials', async () => {
      let authorization: string | undefined;
      const server = http.createServer((req, res) => {
        authorization = req.headers.authorization;
        res.writeHead(200, { 'X-ClickHouse-Format': 'JSONEachRow' });
        res.end('{"database":"default","readonly":"0"}\n');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        await connector.connect(`clickhouse://reader:p%40ss@127.0.0.1:${port}/default`);
        expect(authorization).toBe(`Basic ${Buffer.from('reader:p@ss').toString('base64')}`);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('reports an unreachable server with its socket error code', async () => {
      await fake.stop();
      await expect(connect()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    });

    it('reports rejected credentials with the server error code', async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(403);
        res.end('Code: 516. DB::Exception: reader: Authentication failed: password is incorrect. (AUTHENTICATION_FAILED)');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        await expect(
          connector.connect(`clickhouse://reader:wrong@127.0.0.1:${port}/default`)
        ).rejects.toMatchObject({ code: '516', type: 'AUTHENTICATION_FAILED' });
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('gives up after connection_timeout with a timeout code', async () => {
      const server = http.createServer(() => {
        // never answers
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        await expect(
          connector.connect(`clickhouse://reader:x@127.0.0.1:${port}/default`, undefined, {
            connectionTimeoutSeconds: 0.2,
          })
        ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('executeSQL request', () => {
    it('sends the statement unchanged with the row format and output settings', async () => {
      await connect();
      await connector.executeSQL('SELECT 1 AS n LIMIT 5 BY n', { maxRows: 10 });

      const [request] = fake.statements;
      expect(request.body).toBe('SELECT 1 AS n LIMIT 5 BY n');
      expect(request.params.get('default_format')).toBe('JSONCompactEachRowWithNamesAndTypes');
      expect(request.params.get('database')).toBe('analytics');
      expect(request.params.get('output_format_json_quote_64bit_integers')).toBe('0');
      expect(request.params.get('output_format_json_quote_decimals')).toBe('1');
      expect(request.params.get('cancel_http_readonly_queries_on_client_close')).toBe('1');
      expect(request.params.get('buffer_size')).toBe('1048576');
    });

    it('sets readonly = 1 for a read-only tool only', async () => {
      await connect();
      await connector.executeSQL('SELECT 1', { readonly: true });
      await connector.executeSQL('INSERT INTO t VALUES (1)', {});

      expect(fake.statements[0].params.get('readonly')).toBe('1');
      expect(fake.statements[1].params.has('readonly')).toBe(false);
    });

    it('sends query_timeout as max_execution_time and [sources.session] as settings', async () => {
      await connect({
        queryTimeoutSeconds: 12.5,
        sessionSettings: { max_rows_to_read: 1000000000n, max_memory_usage: 5e9, use_uncompressed_cache: false },
      });
      await connector.executeSQL('SELECT 1', { readonly: true });

      const { params } = fake.statements[0];
      expect(params.get('max_execution_time')).toBe('13');
      expect(params.get('max_rows_to_read')).toBe('1000000000');
      expect(params.get('max_memory_usage')).toBe('5000000000');
      expect(params.get('use_uncompressed_cache')).toBe('0');
      expect(params.get('readonly')).toBe('1');
    });

    it('binds positional parameters to p1, p2, ...', async () => {
      await connect();
      await connector.executeSQL(
        'SELECT * FROM t WHERE tenant = {p1:String} AND day >= {p2:Date} AND id IN {p3:Array(UInt32)}',
        {},
        ["o'brien", '2026-01-01', [1, 2]]
      );

      const { params } = fake.statements[0];
      expect(params.get('param_p1')).toBe("o\\'brien");
      expect(params.get('param_p2')).toBe('2026-01-01');
      expect(params.get('param_p3')).toBe('[1,2]');
    });

    it('runs a batch as one request per statement, in order', async () => {
      await connect();
      fake.respond = ({ body }) => ({
        body: result(['v'], ['String'], [[body]]),
        summary: { read_rows: '5', read_bytes: '40' },
      });

      const { resultSets, messages } = await connector.executeSQL(
        "SELECT 'a;b' AS v; -- trailing; comment\nSELECT 2 AS v;",
        {}
      );

      expect(fake.statements.map((request) => request.body)).toEqual([
        "SELECT 'a;b' AS v",
        '-- trailing; comment\nSELECT 2 AS v',
      ]);
      expect(resultSets.map((set) => set.sql)).toEqual(fake.statements.map((request) => request.body));
      expect(messages?.map((message) => message.text)).toEqual([
        'Statement 1: Read 5 rows (40 bytes)',
        'Statement 2: Read 5 rows (40 bytes)',
      ]);
    });

    it('returns no result sets for an empty batch without calling the server', async () => {
      await connect();
      expect(await connector.executeSQL('  ;  ', {})).toEqual({ resultSets: [] });
      expect(fake.statements).toHaveLength(0);
    });
  });

  describe('a user whose own profile is read-only', () => {
    it('sends no setting at all for a readonly = 1 user', async () => {
      fake.readonly = '1';
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
      await connect({ queryTimeoutSeconds: 30 });
      await connector.executeSQL('SELECT 1', { readonly: true });

      // Nothing but the probe at connect time: there are no settings to check.
      expect(fake.connectRequests).toBe(1);
      // What is left are parameters of the HTTP interface, which are not settings.
      expect([...fake.statements[0].params.keys()].sort()).toEqual([
        'buffer_size',
        'database',
        'default_format',
        'query_id',
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('query_timeout cannot be sent'));
    });

    it('refuses [sources.session] for a readonly = 1 user rather than dropping it', async () => {
      fake.readonly = '1';
      await expect(connect({ sessionSettings: { max_rows_to_read: 1000 } })).rejects.toThrow(
        /restricted to readonly = 1 and cannot change settings/
      );
    });

    it('sends settings but leaves readonly alone for a readonly = 2 user', async () => {
      fake.readonly = '2';
      await connect({ sessionSettings: { max_rows_to_read: 1000 } });
      await connector.executeSQL('SELECT 1', { readonly: true });

      const { params } = fake.statements[0];
      expect(params.get('max_rows_to_read')).toBe('1000');
      expect(params.has('readonly')).toBe(false);
    });
  });

  describe('executeSQL result', () => {
    it('builds rows from positional values, keeping repeated column names apart', async () => {
      await connect();
      fake.respond = () => ({
        body: result(['id', 'count()', 'count()'], ['UInt32', 'UInt64', 'UInt64'], [
          [1, 10, 20],
          [2, 30, 40],
        ]),
      });

      const { resultSets } = await connector.executeSQL('SELECT ...', {});

      expect(resultSets).toHaveLength(1);
      expect(resultSets[0].rowCount).toBe(2);
      expect(resultSets[0].rows.map((row) => ({ ...row }))).toEqual([
        { id: 1, 'count()': 10, 'count()_1': 20 },
        { id: 2, 'count()': 30, 'count()_1': 40 },
      ]);
      expect(resultSets[0].truncated).toBeUndefined();
    });

    it('keeps integers a double cannot hold as text', async () => {
      await connect();
      fake.respond = () => ({
        body:
          '["big","small","neg","arr","f"]\n["UInt64","UInt64","Int64","Array(UInt64)","Float64"]\n' +
          '[18446744073709551615,42,-9223372036854775808,[9007199254740993,1],1.5]\n',
      });

      const { resultSets } = await connector.executeSQL('SELECT ...', {});

      expect({ ...resultSets[0].rows[0] }).toEqual({
        big: '18446744073709551615',
        small: 42,
        neg: '-9223372036854775808',
        arr: ['9007199254740993', 1],
        f: 1.5,
      });
    });

    it('returns an empty result for a query with columns but no rows', async () => {
      await connect();
      fake.respond = () => ({ body: result(['id'], ['UInt32'], []) });

      const { resultSets } = await connector.executeSQL('SELECT id FROM t WHERE 0', {});

      expect(resultSets[0]).toEqual({ sql: 'SELECT id FROM t WHERE 0', rows: [], rowCount: 0 });
    });

    it('caps rows at max_rows and flags the result truncated', async () => {
      await connect();
      const rows = Array.from({ length: 50 }, (_, i) => [i]);
      fake.respond = () => ({
        body: result(['n'], ['UInt32'], rows),
        summary: { read_rows: '50', read_bytes: '200' },
      });

      const { resultSets, messages } = await connector.executeSQL('SELECT n FROM t', { maxRows: 3 });

      expect(resultSets[0].rows.map((row) => row.n)).toEqual([0, 1, 2]);
      expect(resultSets[0].rowCount).toBe(3);
      expect(resultSets[0].truncated).toBe(true);
      // Reading stopped early, so the counters are not known to be final.
      expect(messages).toBeUndefined();
    });

    it('does not flag a result that has exactly max_rows rows', async () => {
      await connect();
      fake.respond = () => ({ body: result(['n'], ['UInt32'], [[1], [2], [3]]) });

      const { resultSets } = await connector.executeSQL('SELECT n FROM t', { maxRows: 3 });

      expect(resultSets[0].rowCount).toBe(3);
      expect(resultSets[0].truncated).toBeUndefined();
    });

    it('stays usable after a capped read', async () => {
      await connect();
      const big = result(['n'], ['UInt32'], Array.from({ length: 20000 }, (_, i) => [i]));
      fake.respond = ({ body }) => ({ body: body.includes('big') ? big : result(['n'], ['UInt8'], [[1]]) });

      await connector.executeSQL('SELECT n FROM big', { maxRows: 1 });
      const { resultSets } = await connector.executeSQL('SELECT 1 AS n', {});

      expect(resultSets[0].rows.map((row) => row.n)).toEqual([1]);
    });

    it('reports what a statement read as a message', async () => {
      await connect();
      fake.respond = () => ({
        body: result(['c'], ['UInt64'], [[1000000]]),
        summary: {
          read_rows: '1000000',
          read_bytes: '8000000',
          written_rows: '0',
          written_bytes: '0',
          elapsed_ns: '12345678',
        },
      });

      const { messages } = await connector.executeSQL('SELECT count() AS c FROM numbers(1000000)', {});

      expect(messages).toEqual([{ text: 'Read 1000000 rows (8000000 bytes) in 0.012s' }]);
    });

    it('leaves the read message out when the response outgrew the server buffer', async () => {
      await connect();
      const wide = 'x'.repeat(1024);
      fake.respond = () => ({
        body: result(['s'], ['String'], Array.from({ length: 1100 }, () => [wide])),
        summary: { read_rows: '7', read_bytes: '7' },
      });

      const { resultSets, messages } = await connector.executeSQL('SELECT s FROM t', {});

      expect(resultSets[0].rowCount).toBe(1100);
      expect(messages).toBeUndefined();
    });

    it('reports rows written by a statement with no result', async () => {
      await connect();
      fake.respond = () => ({
        summary: { read_rows: '3', read_bytes: '24', written_rows: '3', written_bytes: '24' },
      });

      const { resultSets, messages } = await connector.executeSQL('INSERT INTO t SELECT * FROM s', {});

      expect(resultSets[0]).toEqual({ sql: 'INSERT INTO t SELECT * FROM s', rows: [], rowCount: 3 });
      expect(messages).toEqual([{ text: 'Read 3 rows (24 bytes), wrote 3 rows (24 bytes)' }]);
    });

    it('says nothing about cost for a statement that read and wrote nothing', async () => {
      await connect();
      fake.respond = () => ({ summary: { read_rows: '0', read_bytes: '0', written_rows: '0' } });

      const { resultSets, messages } = await connector.executeSQL('CREATE TABLE t (id UInt32) ENGINE = Memory', {});

      expect(resultSets[0].rowCount).toBe(0);
      expect(messages).toBeUndefined();
    });
  });

  describe('executeSQL errors', () => {
    it('raises a server error with its code and type', async () => {
      await connect();
      fake.respond = () => ({
        status: 404,
        body: "Code: 60. DB::Exception: Unknown table expression identifier 'nope' in scope SELECT * FROM nope. (UNKNOWN_TABLE) (version 25.8.1.1)",
      });

      await expect(connector.executeSQL('SELECT * FROM nope', {})).rejects.toMatchObject({
        code: '60',
        type: 'UNKNOWN_TABLE',
        message: expect.stringContaining("Unknown table expression identifier 'nope'"),
      });
    });

    it('raises an error the server appended as text after rows it had already sent', async () => {
      await connect();
      fake.respond = () => ({
        body:
          result(['n'], ['UInt32'], [[1], [2]]) +
          'Code: 159. DB::Exception: Timeout exceeded: elapsed 5.1 seconds, maximum: 5. (TIMEOUT_EXCEEDED) (version 24.8.1.1)\n',
      });

      await expect(connector.executeSQL('SELECT n FROM slow', {})).rejects.toMatchObject({
        code: '159',
        type: 'TIMEOUT_EXCEEDED',
      });
    });

    it('raises an error the server appended in the output format', async () => {
      await connect();
      fake.respond = () => ({
        body:
          result(['a', 'b'], ['UInt32', 'UInt32'], [[1, 2]]) +
          '["Code: 241. DB::Exception: Memory limit (for query) exceeded. (MEMORY_LIMIT_EXCEEDED)"]\n',
      });

      await expect(connector.executeSQL('SELECT a, b FROM t', {})).rejects.toMatchObject({
        code: '241',
        type: 'MEMORY_LIMIT_EXCEEDED',
      });

      fake.respond = () => ({
        body:
          result(['a'], ['UInt32'], [[1]]) +
          '{"exception": "Code: 158. DB::Exception: Limit for rows to read exceeded. (TOO_MANY_ROWS)"}\n',
      });

      await expect(connector.executeSQL('SELECT a FROM t', {})).rejects.toMatchObject({
        code: '158',
        type: 'TOO_MANY_ROWS',
      });
    });

    it("rejects a statement that picks its own FORMAT, which the rows could not be read from", async () => {
      await connect();
      fake.respond = () => ({ format: 'CSV', body: '1,2\n' });

      await expect(connector.executeSQL('SELECT 1, 2 FORMAT CSV', {})).rejects.toThrow(
        /responded in the CSV format/
      );
    });

    it('stops a batch at the first failing statement', async () => {
      await connect();
      fake.respond = ({ body }) =>
        body.includes('boom')
          ? { status: 500, body: 'Code: 62. DB::Exception: Syntax error. (SYNTAX_ERROR)' }
          : { body: result(['n'], ['UInt8'], [[1]]) };

      await expect(connector.executeSQL('SELECT 1 AS n; boom; SELECT 2 AS n', {})).rejects.toMatchObject({
        code: '62',
      });
      expect(fake.statements.map((request) => request.body)).toEqual(['SELECT 1 AS n', 'boom']);
    });

    it('reports the client-side request timeout as a query timeout', async () => {
      const slow = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          if (req.url?.includes('JSONEachRow')) {
            res.writeHead(200, { 'X-ClickHouse-Format': 'JSONEachRow' });
            res.end('{"database":"default","readonly":"0"}\n');
          }
          // any other statement never answers
        });
      });
      await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
      const { port } = slow.address() as AddressInfo;
      try {
        await connector.connect(`clickhouse://reader:x@127.0.0.1:${port}/default`, undefined, {
          queryTimeoutSeconds: 1,
        });
        await expect(connector.executeSQL('SELECT sleep(3)', {})).rejects.toMatchObject({
          code: 'DBHUB_CLIENT_QUERY_TIMEOUT',
        });
      } finally {
        slow.closeAllConnections();
        await new Promise((resolve) => slow.close(resolve));
      }
    });
  });

  describe('introspection', () => {
    /** Answer catalog queries (JSONEachRow) by the system table they read. */
    const catalog = (tables: Record<string, unknown[]>) => {
      fake.respond = ({ body }) => {
        const table = Object.keys(tables).find((name) => body.includes(name));
        // As the server does, one line per row and nothing at all for no rows.
        return { body: (table ? tables[table] : []).map((row) => JSON.stringify(row) + '\n').join('') };
      };
    };

    it('runs catalog queries read-only, binding names as parameters', async () => {
      await connect();
      catalog({ 'system.tables': [{ name: 'events' }] });

      expect(await connector.getTables("o'dd")).toEqual(['events']);

      const { params, body } = fake.statements[0];
      expect(params.get('readonly')).toBe('1');
      expect(params.get('param_database')).toBe("o\\'dd");
      expect(body).not.toContain("o'dd");
    });

    it('lists tables and views from the DSN database by default', async () => {
      await connect();
      catalog({ 'system.tables': [{ name: 'events' }] });

      await connector.getTables();
      await connector.getViews();

      expect(fake.statements[0].params.get('param_database')).toBe('analytics');
      expect(fake.statements[0].body).toMatch(/engine NOT IN \('View', 'MaterializedView'/);
      expect(fake.statements[1].body).toMatch(/engine IN \('View', 'MaterializedView'/);
    });

    it('maps columns: nullability from the type, computed defaults with their keyword', async () => {
      await connect();
      catalog({
        'system.columns': [
          { name: 'id', type: 'UInt64', default_kind: '', default_expression: '', comment: 'Row id' },
          { name: 'note', type: 'Nullable(String)', default_kind: '', default_expression: '', comment: '' },
          { name: 'tag', type: 'LowCardinality(Nullable(String))', default_kind: 'DEFAULT', default_expression: "'x'", comment: '' },
          { name: 'day', type: 'Date', default_kind: 'MATERIALIZED', default_expression: 'toDate(ts)', comment: '' },
          { name: 'arr', type: 'Array(Nullable(String))', default_kind: 'ALIAS', default_expression: 'splitByChar(\',\', note)', comment: '' },
        ],
      });

      expect(await connector.getTableSchema('events')).toEqual([
        { column_name: 'id', data_type: 'UInt64', is_nullable: 'NO', column_default: null, description: 'Row id' },
        { column_name: 'note', data_type: 'Nullable(String)', is_nullable: 'YES', column_default: null, description: null },
        { column_name: 'tag', data_type: 'LowCardinality(Nullable(String))', is_nullable: 'YES', column_default: "'x'", description: null },
        { column_name: 'day', data_type: 'Date', is_nullable: 'NO', column_default: 'MATERIALIZED toDate(ts)', description: null },
        { column_name: 'arr', data_type: 'Array(Nullable(String))', is_nullable: 'NO', column_default: "ALIAS splitByChar(',', note)", description: null },
      ]);
    });

    it('reports the primary key, a longer sorting key and skipping indexes, none unique', async () => {
      await connect();
      catalog({
        'system.tables': [{ primary_key: 'tenant_id, toDate(ts)', sorting_key: 'tenant_id, toDate(ts), id' }],
        'system.data_skipping_indices': [{ name: 'idx_url', expr: 'lower(url)' }],
      });

      expect(await connector.getTableIndexes('events')).toEqual([
        { index_name: 'PRIMARY KEY', column_names: ['tenant_id', 'toDate(ts)'], is_unique: false, is_primary: true },
        { index_name: 'ORDER BY', column_names: ['tenant_id', 'toDate(ts)', 'id'], is_unique: false, is_primary: false },
        { index_name: 'idx_url', column_names: ['lower(url)'], is_unique: false, is_primary: false },
      ]);
    });

    it('reports one key when the sorting key is the primary key, and none for a keyless table', async () => {
      await connect();
      catalog({ 'system.tables': [{ primary_key: 'id', sorting_key: 'id' }] });
      expect(await connector.getTableIndexes('t')).toEqual([
        { index_name: 'PRIMARY KEY', column_names: ['id'], is_unique: false, is_primary: true },
      ]);

      catalog({ 'system.tables': [{ primary_key: '', sorting_key: '' }] });
      expect(await connector.getTableIndexes('log')).toEqual([]);
    });

    it('reads row counts and comments, with null where the engine tracks none', async () => {
      await connect();
      catalog({ 'system.tables': [{ total_rows: '1234', comment: 'Raw events' }] });
      expect(await connector.getTableRowCount('events')).toBe(1234);
      expect(await connector.getTableComment('events')).toBe('Raw events');

      catalog({ 'system.tables': [{ total_rows: null, comment: '' }] });
      expect(await connector.getTableRowCount('v')).toBeNull();
      expect(await connector.getTableComment('v')).toBeNull();
    });

    it('lists SQL user-defined functions as functions and has no procedures', async () => {
      await connect();
      catalog({
        'system.functions': [
          { name: 'plus_one', create_query: 'CREATE FUNCTION plus_one AS (x, y) -> ((x + y) + 1)' },
        ],
      });

      expect(await connector.getStoredProcedures('analytics', 'procedure')).toEqual([]);
      expect(fake.statements).toHaveLength(0);
      expect(await connector.getStoredProcedures('analytics', 'function')).toEqual(['plus_one']);
      expect(await connector.getStoredProcedureDetail('plus_one')).toEqual({
        procedure_name: 'plus_one',
        procedure_type: 'function',
        language: 'sql',
        parameter_list: 'x, y',
        definition: 'CREATE FUNCTION plus_one AS (x, y) -> ((x + y) + 1)',
      });

      catalog({});
      await expect(connector.getStoredProcedureDetail('missing')).rejects.toThrow("Function 'missing' not found");
    });

    it('leaves system databases out of the schema list', async () => {
      await connect();
      catalog({ 'system.databases': [{ name: 'analytics' }, { name: 'default' }] });

      expect(await connector.getSchemas()).toEqual(['analytics', 'default']);
      expect(fake.statements[0].body).toMatch(/NOT IN \('system', 'INFORMATION_SCHEMA', 'information_schema'\)/);
    });
  });

  it('refuses to run before connect', async () => {
    await expect(connector.executeSQL('SELECT 1', {})).rejects.toThrow('Not connected to ClickHouse database');
    await expect(connector.getTables()).rejects.toThrow('Not connected to ClickHouse database');
  });
});

/** A self-signed certificate for `localhost`, or null when the `openssl` CLI is not available. */
function selfSignedCertificate(): { key: Buffer; cert: Buffer } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-clickhouse-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
        '-keyout', 'key.pem', '-out', 'cert.pem',
      ],
      { cwd: dir, stdio: 'pipe' }
    );
    return {
      key: fs.readFileSync(path.join(dir, 'key.pem')),
      cert: fs.readFileSync(path.join(dir, 'cert.pem')),
    };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const certificate = selfSignedCertificate();

describe.skipIf(certificate === null)('ClickHouseConnector over HTTPS', () => {
  let server: https.Server;
  let port: number;
  let connector: ClickHouseConnector;

  beforeEach(async () => {
    server = https.createServer(certificate!, (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'X-ClickHouse-Format': 'JSONEachRow' });
        res.end('{"database":"default","readonly":"0"}\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    connector = new ClickHouseConnector();
  });

  afterEach(async () => {
    await connector.disconnect();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('connects with sslmode=require without verifying the certificate', async () => {
    await connector.connect(`clickhouse://default:pw@localhost:${port}/default?sslmode=require`);
    expect(await connector.getDefaultSchema()).toBe('default');
  });

  it('refuses a certificate it cannot verify with sslmode=verify-full', async () => {
    await expect(
      connector.connect(`clickhouse://default:pw@localhost:${port}/default?sslmode=verify-full`)
    ).rejects.toMatchObject({ code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_VERIFY/) });
  });

  it('speaks plain HTTP when no sslmode is given, which a TLS-only server does not answer', async () => {
    await expect(connector.connect(`clickhouse://default:pw@localhost:${port}/default`)).rejects.toThrow();
  });
});

describe('splitKeyExpression', () => {
  it('splits on top-level commas only', () => {
    expect(splitKeyExpression('a, toDate(b), (c, d), `x,y`, arr[1], cityHash64(e, \'f,g\')')).toEqual([
      'a',
      'toDate(b)',
      '(c, d)',
      '`x,y`',
      'arr[1]',
      "cityHash64(e, 'f,g')",
    ]);
  });

  it('returns nothing for an empty key', () => {
    expect(splitKeyExpression('')).toEqual([]);
    expect(splitKeyExpression('   ')).toEqual([]);
  });
});

describe('describeSummary', () => {
  it('describes reads and writes with elapsed time when the server reports it', () => {
    expect(describeSummary({ read_rows: '10', read_bytes: '80', elapsed_ns: '1500000000' })).toBe(
      'Read 10 rows (80 bytes) in 1.500s'
    );
    expect(describeSummary({ written_rows: '2', written_bytes: '16' })).toBe('Wrote 2 rows (16 bytes)');
  });

  it('is undefined when nothing was read or written', () => {
    expect(describeSummary({ read_rows: '0', written_rows: '0', elapsed_ns: '5' })).toBeUndefined();
    expect(describeSummary({})).toBeUndefined();
  });
});
