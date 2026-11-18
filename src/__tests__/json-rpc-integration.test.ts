import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnHttpServer, type SpawnedHttpServer } from './spawn-http-server.js';

describe('JSON RPC Integration Tests', () => {
  let server: SpawnedHttpServer;

  beforeAll(async () => {
    server = await spawnHttpServer();

    // Create test tables and data via HTTP request
    await executeSql(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        age INTEGER
      );

      INSERT INTO users (name, email, age) VALUES
      ('John Doe', 'john@example.com', 30),
      ('Jane Smith', 'jane@example.com', 25),
      ('Bob Johnson', 'bob@example.com', 35);
    `);
  }, 45000);

  afterAll(async () => {
    await server?.stop();
  });

  function postMcp(body: unknown, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    return fetch(`${server.baseUrl}/mcp`, {
      method: 'POST',
      signal: init.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...init.headers,
      },
      body: JSON.stringify(body),
    });
  }

  // Call execute_sql over JSON-RPC; returns the raw JSON-RPC response and the
  // tool's own JSON envelope parsed out of it.
  async function executeSql(sql: string, id: string = Math.random().toString(36).slice(2, 11)): Promise<any> {
    const httpResponse = await postMcp({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'execute_sql', arguments: { sql } },
    });

    if (!httpResponse.ok) {
      throw new Error(`HTTP ${httpResponse.status}: ${httpResponse.statusText}`);
    }

    // The stateless legacy path answers spec-standard SSE framing (a single
    // result event per exchange); modern-era responses are plain JSON.
    let text = await httpResponse.text();
    if (httpResponse.headers.get('content-type')?.includes('text/event-stream')) {
      const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) {
        throw new Error(`No data event in SSE response: ${text}`);
      }
      text = dataLine.slice('data: '.length);
    }
    const response = JSON.parse(text);
    expect(response).toHaveProperty('result');
    return { response, content: JSON.parse(response.result.content[0].text) };
  }

  it('uses the DSN env var, not an ambient dbhub.toml', () => {
    // Guards the isolated cwd in spawnHttpServer: if the server is ever spawned
    // from the repo root again, a developer's local dbhub.toml wins over DSN and
    // this reports the cause directly instead of an opaque startup timeout.
    expect(server.logs.join('')).toContain('Configuration source: environment variable');
  });

  // What SQLite itself does with a statement (joins, aggregates, functions,
  // transactions, PRAGMAs) is covered against the connector in
  // src/connectors/__tests__/sqlite.integration.test.ts. These tests cover the
  // path around it: HTTP -> JSON-RPC -> tool handler -> response envelope.
  describe('execute_sql JSON RPC calls', () => {
    it('should answer a SELECT with a JSON-RPC result carrying the rows', async () => {
      const { response, content } = await executeSql('SELECT * FROM users WHERE age > 25 ORDER BY age', 'select-1');

      expect(response).toMatchObject({ jsonrpc: '2.0', id: 'select-1' });
      expect(Array.isArray(response.result.content)).toBe(true);

      expect(content.success).toBe(true);
      expect(content.data.statements).toHaveLength(1);
      expect(content.data.statements[0].count).toBe(2);
      // Integer columns (SQLite hands them over as BigInt) arrive as JSON numbers
      expect(content.data.statements[0].rows).toMatchObject([
        { name: 'John Doe', age: 30 },
        { name: 'Bob Johnson', age: 35 },
      ]);
    });

    it('should handle multiple statements in a single call', async () => {
      const { content } = await executeSql(`
        INSERT INTO users (name, email, age) VALUES ('Test User', 'test@example.com', 28);
        SELECT COUNT(*) as total_users FROM users;
      `);

      expect(content.success).toBe(true);
      // SQLite runs all write statements before read statements, so the
      // INSERT's entry comes first even though it's first in source order
      // too here; the SELECT's entry follows.
      expect(content.data.statements).toHaveLength(2);
      expect(content.data.statements[0]).toEqual({
        sql: "INSERT INTO users (name, email, age) VALUES ('Test User', 'test@example.com', 28)",
        rows: [],
        count: 1,
      });
      expect(content.data.statements[1].rows).toHaveLength(1);
      expect(content.data.statements[1].rows[0].total_users).toBe(4);
    });

    it('should return error for invalid SQL', async () => {
      const { content } = await executeSql('SELECT * FROM non_existent_table');

      expect(content.success).toBe(false);
      expect(content.error).toContain('no such table');
      expect(content.code).toBe('EXECUTION_ERROR');
    });

    it('should handle empty result sets', async () => {
      const { content } = await executeSql('SELECT * FROM users WHERE age > 100');

      expect(content.success).toBe(true);
      expect(content.data.statements).toHaveLength(1);
      expect(content.data.statements[0].rows).toHaveLength(0);
      expect(content.data.statements[0].count).toBe(0);
    });
  });

  describe('JSON RPC protocol compliance', () => {
    it('should handle malformed requests gracefully', async () => {
      const response = await postMcp({
        // Missing required jsonrpc field
        id: 'test',
        method: 'tools/call',
        params: {
          name: 'execute_sql',
          arguments: { sql: 'SELECT 1' }
        }
      });

      // The server should still respond, but with an error
      expect(response.status).toBeLessThan(500);
    });
  });

  describe('2026-07-28 subscriptions/listen', () => {
    // DBHub never emits change notifications (a fresh stateless server is
    // built per request), yet the SDK advertises tools.listChanged, so
    // modern clients open subscriptions/listen right after discovery and
    // wait on it before listing tools. The handler must refuse the listen
    // in-band at once rather than hold the POST open as an empty stream:
    // behind a buffering proxy (AWS API Gateway cuts at 30s with a 503) a
    // held-open listen delays tool discovery by the proxy timeout. See
    // https://github.com/bytebase/dbhub/issues/474.
    it('refuses subscriptions/listen in-band instead of holding the request open', async () => {
      const logLengthBefore = server.logs.length;
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 5000);
      let response: Response;
      try {
        response = await postMcp(
          {
            jsonrpc: '2.0',
            id: 'listen-1',
            method: 'subscriptions/listen',
            params: {
              notifications: { tools: true },
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          },
          {
            signal: controller.signal,
            headers: { 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'subscriptions/listen' },
          }
        );
      } finally {
        clearTimeout(abortTimer);
      }

      // In-band refusal: HTTP 200 carrying a JSON-RPC error. Without the
      // limit the handler instead answers with a text/event-stream it holds
      // open until the client gives up (the abort above).
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = await response.json();
      expect(body).toMatchObject({
        jsonrpc: '2.0',
        id: 'listen-1',
        error: { code: -32603, message: 'Subscription limit reached' },
      });

      // The SDK reports each refusal through onerror; with the limit at 0
      // that is the configured answer, so it must not land in the log.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const newLogs = server.logs.slice(logLengthBefore).join('');
      expect(newLogs).not.toContain('subscriptions/listen refused');
    });
  });
});
