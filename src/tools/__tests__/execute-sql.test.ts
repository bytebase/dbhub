import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExecuteSqlToolHandler } from '../execute-sql.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { getToolRegistry } from '../registry.js';
import type { Connector, ConnectorType, SQLResult } from '../../connectors/interface.js';
import { requestStore } from '../../requests/index.js';
import { SafeExecutionError } from '../../utils/safe-execution-error.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');
vi.mock('../registry.js');

// Mock connector for testing
const createMockConnector = (id: ConnectorType = 'sqlite', sourceId: string = 'default'): Connector => ({
  id,
  name: 'Mock Connector',
  getId: () => sourceId,
  dsnParser: {} as any,
  connect: vi.fn(),
  disconnect: vi.fn(),
  clone: vi.fn(),
  getSchemas: vi.fn(),
  getTables: vi.fn(),
  getViews: vi.fn(),
  tableExists: vi.fn(),
  getTableSchema: vi.fn(),
  getTableIndexes: vi.fn(),
  getStoredProcedures: vi.fn(),
  getStoredProcedureDetail: vi.fn(),
  executeSQL: vi.fn(),
});

// Helper function to parse tool response
const parseToolResponse = (response: any) => {
  return JSON.parse(response.content[0].text);
};

describe('execute-sql tool', () => {
  let mockConnector: Connector;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);
  const mockGetToolRegistry = vi.mocked(getToolRegistry);

  beforeEach(() => {
    requestStore.clear();
    mockConnector = createMockConnector('sqlite');
    mockGetCurrentConnector.mockReturnValue(mockConnector);

    // Mock tool registry to return empty config (no readonly, no max_rows)
    mockGetToolRegistry.mockReturnValue({
      getBuiltinToolConfig: vi.fn().mockReturnValue({}),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('basic execution', () => {
    it('should execute SELECT and return rows', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1, name: 'test' }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(parsedResult.data.rows).toEqual([{ id: 1, name: 'test' }]);
      expect(parsedResult.data.count).toBe(1);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT * FROM users', { readonly: undefined, maxRows: undefined });
    });

    it('should pass multi-statement SQL directly to connector', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1 }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT * FROM users; SELECT * FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, { readonly: undefined, maxRows: undefined });
    });

    it('should handle execution errors', async () => {
      vi.mocked(mockConnector.executeSQL).mockRejectedValue(new Error('Database error'));

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM invalid_table' }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.success).toBe(false);
      expect(parsedResult.error).toBe('Database query execution failed.');
      expect(parsedResult.code).toBe('EXECUTION_ERROR');
      expect(requestStore.getAll('test_source')[0]?.error).toBe(
        'EXECUTION_ERROR: Database query execution failed.'
      );
      expect(requestStore.getAll('test_source')[0]?.error).not.toContain('Database error');
    });

    it('returns SOURCE_UNREACHABLE when the connector throws a network error', async () => {
      const econn: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      econn.code = 'ECONNREFUSED';
      mockGetCurrentConnector.mockReturnValue({
        id: 'postgres',
        getId: () => 'prod',
        executeSQL: vi.fn().mockRejectedValue(econn),
      } as any);
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ id: 'prod', type: 'postgres' } as any);
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);

      const handler = createExecuteSqlToolHandler('prod');
      const res: any = await handler({ sql: 'SELECT 1' }, {});
      const payload = JSON.parse(res.content[0].text);

      expect(res.isError).toBe(true);
      expect(payload.code).toBe('SOURCE_UNREACHABLE');
      expect(payload.error).toBe(
        'The database source is unreachable. Verify the database is running and reachable (host, port, network), then retry.'
      );
      expect(payload.details).toBeUndefined();
      expect(requestStore.getAll('prod')[0]?.error).toBe(
        `SOURCE_UNREACHABLE: ${payload.error}`
      );
    });

    it('falls through to EXECUTION_ERROR when the source config is null', async () => {
      const econn: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      econn.code = 'ECONNREFUSED';
      mockGetCurrentConnector.mockReturnValue({
        id: 'postgres',
        getId: () => 'prod',
        executeSQL: vi.fn().mockRejectedValue(econn),
      } as any);
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue(null as any);
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);

      const handler = createExecuteSqlToolHandler('prod');
      const res: any = await handler({ sql: 'SELECT 1' }, {});
      const payload = JSON.parse(res.content[0].text);

      expect(res.isError).toBe(true);
      expect(payload.code).toBe('EXECUTION_ERROR');
    });

    it('uses the display source id "default" in single-source mode', async () => {
      const econn: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      econn.code = 'ECONNREFUSED';
      mockGetCurrentConnector.mockReturnValue({
        id: 'postgres',
        getId: () => 'default',
        executeSQL: vi.fn().mockRejectedValue(econn),
      } as any);
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ type: 'postgres' } as any);
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);

      const handler = createExecuteSqlToolHandler();
      const res: any = await handler({ sql: 'SELECT 1' }, {});
      const payload = JSON.parse(res.content[0].text);

      expect(res.isError).toBe(true);
      expect(payload.code).toBe('SOURCE_UNREACHABLE');
      expect(payload.details).toBeUndefined();
    });

    it('maps SafeExecutionError without exposing its cause', async () => {
      const sentinel = 'RAW_CAUSE_SENTINEL';
      vi.mocked(mockConnector.executeSQL).mockRejectedValue(
        new SafeExecutionError(
          'MYSQL_READONLY_GUARDRAIL',
          'dangerous_function',
          { cause: new Error(sentinel) }
        )
      );

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT SLEEP(1)' }, null);
      const payload = parseToolResponse(result);

      expect(payload).toMatchObject({
        code: 'MYSQL_READONLY_GUARDRAIL',
        error: 'MySQL read-only guardrail rejected the query.',
      });
      expect(JSON.stringify(payload)).not.toContain(sentinel);
      expect(requestStore.getAll('test_source')[0]?.error).toBe(
        'MYSQL_READONLY_GUARDRAIL: MySQL read-only guardrail rejected the query.'
      );
    });

    it('maps MySQL safety precondition failures through the same safe view', async () => {
      vi.mocked(mockConnector.executeSQL).mockRejectedValue(
        new SafeExecutionError(
          'MYSQL_SAFETY_CHECK_FAILED',
          'sql_mode_unavailable',
          { cause: new Error('RAW_MODE_SENTINEL') }
        )
      );

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT 1' }, null);
      const payload = parseToolResponse(result);

      expect(payload).toMatchObject({
        code: 'MYSQL_SAFETY_CHECK_FAILED',
        error: 'MySQL safety precondition failed.',
      });
      expect(JSON.stringify(payload)).not.toContain('RAW_MODE_SENTINEL');
      expect(requestStore.getAll('test_source')[0]?.error).toBe(
        'MYSQL_SAFETY_CHECK_FAILED: MySQL safety precondition failed.'
      );
    });
  });

  describe('read-only mode enforcement', () => {
    beforeEach(() => {
      // Set per-source readonly mode via tool registry (simulates TOML config)
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true }),
      } as any);
    });

    it('should allow SELECT statements', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1 }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT * FROM users', { readonly: true, maxRows: undefined });
    });

    it('should allow multiple read-only statements', async () => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT * FROM users; SELECT * FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });

    it.each([
      ['INSERT', "INSERT INTO users (name) VALUES ('test')"],
      ['UPDATE', "UPDATE users SET name = 'x' WHERE id = 1"],
      ['DELETE', "DELETE FROM users WHERE id = 1"],
      ['DROP', "DROP TABLE users"],
      ['CREATE', "CREATE TABLE test (id INT)"],
      ['ALTER', "ALTER TABLE users ADD COLUMN email VARCHAR(255)"],
      ['TRUNCATE', "TRUNCATE TABLE users"],
    ])('should reject %s statement', async (_, sql) => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.code).toBe('READONLY_VIOLATION');
      expect(parsedResult.error).toBe(
        'The tool cannot execute this statement in readonly mode. Only read-only SQL operations are allowed.'
      );
      expect(requestStore.getAll('test_source')[0]?.error).toBe(
        `READONLY_VIOLATION: ${parsedResult.error}`
      );
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should reject multi-statement with any write operation', async () => {
      const sql = "SELECT * FROM users; INSERT INTO users (name) VALUES ('test');";
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(result.isError).toBe(true);
      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });

    it.each([
      ['bare CR', "SELECT 1 -- comment\r; DROP TABLE victim"],
      ['CRLF', "SELECT 1 -- comment\r\n; DROP TABLE victim"],
    ])('should reject a MySQL stacked DROP after a %s line ending', async (_, sql) => {
      const mysqlConnector = createMockConnector('mysql', 'test_source');
      mockGetCurrentConnector.mockReturnValue(mysqlConnector);
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
      expect(mysqlConnector.executeSQL).not.toHaveBeenCalled();
    });

  });

  describe('readonly per-source isolation', () => {
    // Verifies readonly is enforced per-source from tool registry, not globally

    it.each([
      ['readonly: false', { readonly: false }],
      ['readonly: undefined', {}],
    ])('should allow writes when %s', async (_, toolConfig) => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue(toolConfig),
      } as any);
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('writable_source');
      const result = await handler({ sql: "INSERT INTO users (name) VALUES ('test')" }, null);

      expect(parseToolResponse(result).success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalled();
    });

    it('should enforce readonly even with other options set', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true, max_rows: 100 }),
      } as any);

      const handler = createExecuteSqlToolHandler('limited_source');
      const result = await handler({ sql: "DELETE FROM users" }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });
  });

  describe('SQL comments handling in readonly mode', () => {
    beforeEach(() => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true }),
      } as any);
    });

    it.each([
      ['single-line comment', '-- Fetch users\nSELECT * FROM users'],
      ['multi-line comment', '/* Fetch all */\nSELECT * FROM products'],
      ['inline comments', 'SELECT id, -- user id\n       name FROM users'],
    ])('should allow SELECT with %s', async (_, sql) => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });

    it('should reject comment-only SQL in readonly mode', async () => {
      const sql = '-- Just a comment\n/* Another */';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });

    it('should reject MySQL conditional comment bypass with mysql connector', async () => {
      const mysqlConnector = createMockConnector('mysql', 'mysql_source');
      mockGetCurrentConnector.mockReturnValue(mysqlConnector);

      const sql = 'SELECT 1; /*!50000 DROP TABLE users */';
      const handler = createExecuteSqlToolHandler('mysql_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });

    it('should reject MariaDB M-bang comment bypass with mariadb connector', async () => {
      const mariadbConnector = createMockConnector('mariadb', 'mariadb_source');
      mockGetCurrentConnector.mockReturnValue(mariadbConnector);

      const sql = 'SELECT 1; /*M! DELETE FROM users */';
      const handler = createExecuteSqlToolHandler('mariadb_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });

    it('should reject write statement hidden after comment', async () => {
      const sql = '-- Insert new user\nINSERT INTO users (name) VALUES (\'test\')';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });
  });

  describe('edge cases', () => {
    it.each([
      ['empty string', ''],
      ['only semicolons and whitespace', '   ;  ;  ; '],
    ])('should handle %s', async (_, sql) => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });
  });
});
