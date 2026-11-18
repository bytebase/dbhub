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
  hasSettingsClause,
  keepExactNumbers,
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
  /** Sends `body` forever, one copy every few milliseconds, instead of once. */
  endless?: boolean;
  /** Milliseconds to wait before answering. */
  delayMs?: number;
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
  /** The user's http_write_exception_in_output_format, or null on a server without the setting. */
  exceptionInFormat: string | null = '0';
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
      if (seen.body.includes('FROM system.settings WHERE name = {name:String}')) {
        res.writeHead(200, { 'X-ClickHouse-Format': format });
        res.end(this.exceptionInFormat === null ? '' : JSON.stringify({ value: this.exceptionInFormat }) + '\n');
        return;
      }
      const response = this.respond(seen);
      res.writeHead(response.status ?? 200, {
        'X-ClickHouse-Format': response.format ?? format,
        ...(response.summary && { 'X-ClickHouse-Summary': JSON.stringify(response.summary) }),
      });
      if (response.endless) {
        const drip = setInterval(() => res.write(response.body ?? ''), 20);
        res.on('close', () => clearInterval(drip));
        return;
      }
      if (response.delayMs) {
        setTimeout(() => res.end(response.body ?? ''), response.delayMs);
        return;
      }
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

    it('goes without http_write_exception_in_output_format on a server that predates it', async () => {
      fake.respond = ({ params }) =>
        params.has('http_write_exception_in_output_format')
          ? { status: 400, body: "Code: 115. DB::Exception: Unknown setting 'http_write_exception_in_output_format'. (UNKNOWN_SETTING)" }
          : {};

      await connect({ sessionSettings: { max_rows_to_read: 1000 } });
      await connector.executeSQL('SELECT 1', {});

      const { params } = fake.statements[0];
      expect(params.has('http_write_exception_in_output_format')).toBe(false);
      expect(params.get('max_rows_to_read')).toBe('1000');
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
      expect(request.params.get('http_write_exception_in_output_format')).toBe('0');
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

      // At connect time: the probe, and a look at one profile setting. Neither sends a setting.
      expect(fake.connectRequests).toBe(2);
      expect([...fake.requests[1].params.keys()].sort()).toEqual([
        'buffer_size',
        'database',
        'default_format',
        'param_name',
        'query_id',
      ]);
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

  describe('a SETTINGS clause from a readonly = 2 user', () => {
    beforeEach(async () => {
      fake.readonly = '2';
      await connect({ sessionSettings: { max_rows_to_read: 100 } });
    });

    it.each([
      ['a trailing clause', 'SELECT sum(number) FROM numbers(1000000) SETTINGS max_rows_to_read = 0'],
      ['a quoted setting name', 'SELECT 1 SETTINGS `max_rows_to_read` = 0'],
      ['a clause inside a subquery', 'SELECT * FROM (SELECT 1 SETTINGS max_threads = 1)'],
      ['a clause in a later statement of the batch', 'SELECT 1; SELECT 2 SETTINGS max_threads = 1'],
    ])('is refused for a read-only tool: %s', async (_label, sql) => {
      await expect(connector.executeSQL(sql, { readonly: true })).rejects.toThrow(
        /SETTINGS clause is not allowed/
      );
      // Refused before anything is sent, the earlier statements of a batch included.
      expect(fake.statements).toHaveLength(0);
    });

    it('leaves statements without one alone, the system.settings table included', async () => {
      await connector.executeSQL(
        "SELECT name, value FROM system.settings WHERE name = 'max_threads' -- SETTINGS x = 1",
        { readonly: true }
      );
      expect(fake.statements).toHaveLength(1);
    });

    it('is left to the server for a tool that is not read-only', async () => {
      await connector.executeSQL('SELECT 1 SETTINGS max_threads = 1', {});
      expect(fake.statements).toHaveLength(1);
    });
  });

  describe('errors a readonly = 1 profile has the server write as rows', () => {
    const errorText =
      "Code: 395. DB::Exception: review exception: while executing 'FUNCTION throwIf()'. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) (version 25.8.1.1)";
    // More rows than fit the server's buffer, so the response is one it had begun to send.
    const streamed = (value: unknown) => Array.from({ length: 150000 }, () => [value]);

    beforeEach(async () => {
      fake.readonly = '1';
      fake.exceptionInFormat = '1';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await connect();
    });

    it('rejects when the last row of a one-column result is the error', async () => {
      fake.respond = () => ({ body: result(['n'], ['UInt8'], [[0], [0], [errorText]]) });

      await expect(connector.executeSQL('SELECT throwIf(...) AS n FROM t', {})).rejects.toMatchObject({
        code: '395',
        type: 'FUNCTION_THROW_IF_VALUE_IS_NON_ZERO',
      });
    });

    it('rejects when a text column of a response that had begun streaming ends on the error', async () => {
      fake.respond = () => ({ body: result(['s'], ['String'], [...streamed('some text'), [errorText]]) });

      await expect(connector.executeSQL('SELECT s FROM t', {})).rejects.toMatchObject({ code: '395' });
    });

    it('returns error text that is data: in a short result, or followed by more rows', async () => {
      fake.respond = () => ({ body: result(['exception'], ['String'], [['ok'], [errorText]]) });
      const short = await connector.executeSQL('SELECT exception FROM system.query_log', {});
      expect(short.resultSets[0].rows.map((row) => row.exception)).toEqual(['ok', errorText]);

      fake.respond = () => ({
        body: result(['exception'], ['Nullable(String)'], [...streamed('x'), [errorText], ['after']]),
      });
      const long = await connector.executeSQL('SELECT exception FROM system.query_log', {});
      expect(long.resultSets[0].rowCount).toBe(150002);
      expect(long.resultSets[0].rows.at(-2)?.exception).toBe(errorText);
    });

    it('counts a held-back row against max_rows like any other', async () => {
      fake.respond = () => ({ body: result(['s'], ['String'], [['a'], [errorText], ['b'], ['c']]) });

      const { resultSets } = await connector.executeSQL('SELECT s FROM t', { maxRows: 2 });

      expect(resultSets[0].rows.map((row) => row.s)).toEqual(['a', errorText]);
      expect(resultSets[0].truncated).toBe(true);
    });
  });

  it('returns error-like text as data when the server cannot write errors as rows', async () => {
    await connect();
    const errorText = 'Code: 60. DB::Exception: Unknown table. (UNKNOWN_TABLE)';
    fake.respond = () => ({
      body: result(['exception'], ['String'], [...Array.from({ length: 150000 }, () => ['x']), [errorText]]),
    });

    const { resultSets } = await connector.executeSQL('SELECT exception FROM system.query_log', {});

    expect(resultSets[0].rowCount).toBe(150001);
    expect(resultSets[0].rows.at(-1)?.exception).toBe(errorText);
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

    it('keeps decimals exact when the server sends them as bare numbers', async () => {
      // What a readonly = 1 user gets: no setting can ask for quoted decimals.
      fake.readonly = '1';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await connect();
      fake.respond = () => ({
        body:
          '["amount","small","nullable","nested","ratio"]\n' +
          '["Decimal(38, 2)","Decimal(18, 2)","Nullable(Decimal(9, 3))","Array(Decimal(38, 2))","Float64"]\n' +
          '[12345678901234567890.12,1.50,0.125,[12345678901234567890.12,2.5],0.1]\n' +
          '[-0.01,100,null,[],1e-7]\n',
      });

      const { resultSets } = await connector.executeSQL('SELECT ...', {});

      expect(resultSets[0].rows.map((row) => ({ ...row }))).toEqual([
        // Decimal columns are text whether or not a double could hold the value
        { amount: '12345678901234567890.12', small: '1.5', nullable: '0.125', nested: ['12345678901234567890.12', 2.5], ratio: 0.1 },
        { amount: '-0.01', small: '100', nullable: null, nested: [], ratio: 1e-7 },
      ]);
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

    it('raises an error the server appended between marker lines', async () => {
      await connect();
      fake.respond = () => ({
        body:
          result(['n'], ['UInt8'], [[0], [0]]) +
          '__exception__\r\n' +
          "Code: 395. DB::Exception: review exception: while executing 'FUNCTION throwIf()'. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) (version 25.8.1.1 (official build))\r\n" +
          '160 tagtagtag\r\n__exception__\r\n',
      });

      await expect(connector.executeSQL('SELECT throwIf(...) AS n FROM t', {})).rejects.toMatchObject({
        code: '395',
        type: 'FUNCTION_THROW_IF_VALUE_IS_NON_ZERO',
        message: expect.stringContaining('review exception'),
      });
    });

    it('raises unreadable trailing text as it is when it holds no server error', async () => {
      await connect();
      fake.respond = () => ({ body: result(['n'], ['UInt8'], [[0]]) + '<html>502 Bad Gateway</html>\nupstream\n' });

      await expect(connector.executeSQL('SELECT n FROM t', {})).rejects.toThrow(
        '<html>502 Bad Gateway</html>\nupstream'
      );
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

    it('times out a response that keeps sending rows past the deadline', async () => {
      await connect({ queryTimeoutSeconds: 1 });
      fake.respond = ({ body }) =>
        body.includes('slow')
          ? { body: result(['n'], ['UInt8'], [[1]]), endless: true }
          : { body: result(['n'], ['UInt8'], [[1]]) };

      const started = Date.now();
      await expect(connector.executeSQL('SELECT n FROM slow', {})).rejects.toMatchObject({
        code: 'DBHUB_CLIENT_QUERY_TIMEOUT',
      });
      expect(Date.now() - started).toBeLessThan(2000);

      const after = await connector.executeSQL('SELECT 1 AS n', {});
      expect(after.resultSets[0].rows.map((row) => row.n)).toEqual([1]);
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

  describe('getHealthCheck', () => {
    const MARK_CACHE_NOTE = expect.stringMatching(/^buffer_cache is the mark cache/);
    const denied = (table: string) => ({
      status: 500,
      body: `Code: 497. DB::Exception: reader: Not enough privileges. To execute this query, it's necessary to have the grant SELECT ON ${table}. (ACCESS_DENIED) (version 25.8.1.1)`,
    });

    /** Answer each health query by the system table it reads: rows, or a whole response. */
    const system = (tables: Record<string, unknown[] | FakeResponse>) => {
      fake.respond = ({ body }) => {
        const answer = tables[Object.keys(tables).find((name) => body.includes(`FROM ${name}`)) ?? ''] ?? [];
        return Array.isArray(answer)
          ? { body: answer.map((row) => JSON.stringify(row) + '\n').join('') }
          : answer;
      };
    };

    const healthy = {
      'system.metrics': [{ connections: 7 }],
      'system.processes': [{ active: 2, longest_seconds: 12.5 }],
      'system.server_settings': [{ value: '4096' }],
      'system.events': [
        { event: 'MarkCacheHits', value: 990 },
        { event: 'MarkCacheMisses', value: 10 },
      ],
    };

    it('reports connections less its own, running queries, the ceiling and the mark cache', async () => {
      await connect();
      system(healthy);

      expect(await connector.getHealthCheck()).toEqual({
        connections: {
          total: 6,
          active: 2,
          idle: 4,
          idleInTransaction: 0,
          maxConnections: 4096,
          longestIdleInTransactionSeconds: null,
          longestActiveQuerySeconds: 12.5,
        },
        bufferCache: { hitRatioPct: 99, blocksHit: 990, blocksRead: 10 },
        notes: [MARK_CACHE_NOTE],
      });
    });

    it('reads each system table read-only, counting client connections and leaving its own query out', async () => {
      await connect();
      system(healthy);

      await connector.getHealthCheck();

      expect(fake.statements.map(({ body }) => /FROM (system\.\w+)/.exec(body)?.[1])).toEqual([
        'system.metrics',
        'system.processes',
        'system.server_settings',
        'system.events',
      ]);
      expect(fake.statements.every(({ params }) => params.get('readonly') === '1')).toBe(true);
      expect(fake.statements[0].body).toContain(
        "IN ('TCPConnection', 'HTTPConnection', 'MySQLConnection', 'PostgreSQLConnection')"
      );
      expect(fake.statements[1].body).toContain('query_id != queryID()');
    });

    it('reads the tables one at a time, so the check is never more than one connection', async () => {
      await connect();
      let inFlight = 0;
      let mostInFlight = 0;
      fake.respond = () => {
        mostInFlight = Math.max(mostInFlight, ++inFlight);
        // Set before the fake's own timer of the same delay, so it fires first.
        setTimeout(() => inFlight--, 20);
        return { delayMs: 20 };
      };

      await connector.getHealthCheck();

      expect(fake.statements).toHaveLength(4);
      expect(mostInFlight).toBe(1);
    });

    it('reports an idle server: no query to time, no cache lookups to rate', async () => {
      await connect();
      // Only this check is connected; max() over no queries is 0, and an
      // event that has not happened yet has no row. Counters arrive as text
      // from a server that quotes 64-bit integers.
      system({
        'system.metrics': [{ connections: '1' }],
        'system.processes': [{ active: '0', longest_seconds: 0 }],
        'system.server_settings': [{ value: '4096' }],
        'system.events': [],
      });

      const health = await connector.getHealthCheck();

      expect(health.connections).toMatchObject({ total: 0, active: 0, idle: 0, longestActiveQuerySeconds: null });
      expect(health.bufferCache).toEqual({ hitRatioPct: null, blocksHit: 0, blocksRead: 0 });
    });

    it('does not report fewer than zero idle connections when queries outnumber connections', async () => {
      await connect();
      system({ ...healthy, 'system.metrics': [{ connections: 2 }] });

      expect((await connector.getHealthCheck()).connections).toMatchObject({ total: 1, active: 2, idle: 0 });
    });

    it('names every system table the user may not read, and reports nothing it could not see', async () => {
      await connect();
      system({
        'system.metrics': denied('system.metrics'),
        'system.processes': denied('system.processes'),
        'system.server_settings': denied('system.server_settings'),
        'system.events': denied('system.events'),
      });

      expect(await connector.getHealthCheck()).toEqual({
        notes: [
          'Connected user lacks the SELECT grant on system.metrics, system.processes, system.server_settings, system.events: connections and buffer_cache are not reported.',
        ],
      });
    });

    it('leaves connections out when only one of their two tables can be read', async () => {
      await connect();
      system({ ...healthy, 'system.processes': denied('system.processes') });

      const health = await connector.getHealthCheck();

      expect(health.connections).toBeUndefined();
      expect(health.bufferCache).toBeDefined();
      expect(health.notes).toEqual([
        'Connected user lacks the SELECT grant on system.processes: connections is not reported.',
        MARK_CACHE_NOTE,
      ]);
    });

    it('reports connections without a ceiling when server settings cannot be read', async () => {
      await connect();
      system({ ...healthy, 'system.server_settings': denied('system.server_settings') });

      const health = await connector.getHealthCheck();

      expect(health.connections).toMatchObject({ total: 6, maxConnections: null });
      expect(health.notes).toEqual([
        'Connected user lacks the SELECT grant on system.server_settings: max_connections is not reported.',
        MARK_CACHE_NOTE,
      ]);
    });

    it('goes without a ceiling, and without a complaint, on a server that predates system.server_settings', async () => {
      await connect();
      system({
        ...healthy,
        'system.server_settings': {
          status: 404,
          body: "Code: 60. DB::Exception: Table system.server_settings doesn't exist. (UNKNOWN_TABLE) (version 22.8.1.1)",
        },
      });

      const health = await connector.getHealthCheck();

      expect(health.connections).toMatchObject({ total: 6, maxConnections: null });
      expect(health.notes).toEqual([MARK_CACHE_NOTE]);
    });

    it('fails on an error that is not a missing grant, rather than report a partial result', async () => {
      await connect();
      system({
        ...healthy,
        'system.events': {
          status: 500,
          body: 'Code: 241. DB::Exception: Memory limit (total) exceeded. (MEMORY_LIMIT_EXCEEDED) (version 25.8.1.1)',
        },
      });

      await expect(connector.getHealthCheck()).rejects.toMatchObject({ type: 'MEMORY_LIMIT_EXCEEDED' });
    });
  });

  it('refuses to run before connect', async () => {
    await expect(connector.executeSQL('SELECT 1', {})).rejects.toThrow('Not connected to ClickHouse database');
    await expect(connector.getTables()).rejects.toThrow('Not connected to ClickHouse database');
    await expect(connector.getHealthCheck()).rejects.toThrow('Not connected to ClickHouse database');
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

describe('keepExactNumbers', () => {
  const parse = (text: string): unknown =>
    JSON.parse(text, keepExactNumbers as (key: string, value: unknown) => unknown);

  it.each([
    ['a 64-bit integer past the safe range', '18446744073709551615', '18446744073709551615'],
    ['the first integer a double skips', '9007199254740993', '9007199254740993'],
    ['a decimal with more digits than a double holds', '12345678901234567890.12', '12345678901234567890.12'],
    ['a negative one', '-99999999999999999.99', '-99999999999999999.99'],
    ['a small decimal a double prints in exponent form', '0.0000001', '0.0000001'],
  ])('keeps %s as text', (_label, literal, expected) => {
    expect(parse(literal)).toBe(expected);
  });

  it.each([
    ['a small integer', '42', 42],
    ['an integer a double holds exactly, however large', '9007199254740992', 9007199254740992],
    ['a float', '0.1', 0.1],
    ['a float printed in full', '0.30000000000000004', 0.30000000000000004],
    ['a large float printed without an exponent', '123456789012345680000', 123456789012345680000],
    ['a decimal with trailing zeros', '1.50', 1.5],
    ['zero in any spelling', '-0.00', -0],
    ['exponent notation', '1e-7', 1e-7],
  ])('leaves %s a number', (_label, literal, expected) => {
    expect(parse(literal)).toBe(expected);
  });

  it('applies inside arrays and objects, and leaves strings alone', () => {
    expect(parse('[[18446744073709551615, 1], {"a": 0.5, "b": "18446744073709551615"}]')).toEqual([
      ['18446744073709551615', 1],
      { a: 0.5, b: '18446744073709551615' },
    ]);
  });
});

describe('hasSettingsClause', () => {
  it.each([
    'SELECT 1 SETTINGS max_threads = 1',
    'SELECT 1 settings max_threads=1, max_rows_to_read = 0',
    'SELECT 1 SETTINGS `max_threads` = 1',
    'SELECT 1 SETTINGS /* why */ max_threads = 1',
    'SELECT * FROM (SELECT 1 SETTINGS max_threads = 1) FORMAT JSON',
    'EXPLAIN SELECT 1 SETTINGS max_threads = 1',
  ])('finds the clause in %j', (sql) => {
    expect(hasSettingsClause(sql)).toBe(true);
  });

  it.each([
    'SELECT * FROM system.settings',
    "SELECT * FROM system.settings WHERE name = 'max_threads'",
    'SELECT name FROM system.settings AS s WHERE s.changed = 1',
    "SELECT 'SETTINGS max_threads = 1' AS text",
    'SELECT 1 -- SETTINGS max_threads = 1',
    'SELECT merge_tree_settings FROM t',
  ])('finds none in %j', (sql) => {
    expect(hasSettingsClause(sql)).toBe(false);
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
