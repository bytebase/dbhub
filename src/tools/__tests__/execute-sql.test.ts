import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExecuteSqlToolHandler } from '../execute-sql.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { getToolRegistry } from '../registry.js';
import type { Connector, ConnectorType, SQLResult } from '../../connectors/interface.js';

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
      const mockResult: SQLResult = {
        resultSets: [{ sql: 'SELECT * FROM users', rows: [{ id: 1, name: 'test' }], rowCount: 1 }],
      };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(parsedResult.data.statements).toEqual([
        { sql: 'SELECT * FROM users', rows: [{ id: 1, name: 'test' }], count: 1 },
      ]);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT * FROM users', { readonly: false, maxRows: undefined });
    });

    it('should pass multi-statement SQL directly to connector', async () => {
      const mockResult: SQLResult = {
        resultSets: [
          { sql: 'SELECT * FROM users', rows: [{ id: 1 }], rowCount: 1 },
          { sql: 'SELECT * FROM roles', rows: [{ id: 2 }], rowCount: 1 },
        ],
      };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT * FROM users; SELECT * FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(parsedResult.data.statements).toEqual([
        { sql: 'SELECT * FROM users', rows: [{ id: 1 }], count: 1 },
        { sql: 'SELECT * FROM roles', rows: [{ id: 2 }], count: 1 },
      ]);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, { readonly: false, maxRows: undefined });
    });

    it('should handle execution errors', async () => {
      vi.mocked(mockConnector.executeSQL).mockRejectedValue(new Error('Database error'));

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM invalid_table' }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.success).toBe(false);
      expect(parsedResult.error).toBe('Database error');
      expect(parsedResult.code).toBe('EXECUTION_ERROR');
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
      expect(payload.details.source_id).toBe('prod');
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
      expect(payload.details.source_id).toBe('default');
    });
  });

  describe('read-only mode enforcement', () => {
    // Statement-classification coverage (write keywords, comment stripping,
    // dialect-specific bypasses, ...) is pinned in
    // src/utils/__tests__/sql-access-policy.test.ts. These tests only prove
    // the handler wires into that policy.
    beforeEach(() => {
      // Set per-source readonly mode via tool registry (simulates TOML config)
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true }),
      } as any);
    });

    it('should allow SELECT statements', async () => {
      const mockResult: SQLResult = { resultSets: [{ rows: [{ id: 1 }], rowCount: 1 }] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT * FROM users', { readonly: true, maxRows: undefined });
    });

    it.each([
      ['a write statement', "INSERT INTO users (name) VALUES ('test')"],
      ['a multi-statement containing a write', 'SELECT 1; DROP TABLE t'],
    ])('should reject %s', async (_, sql) => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.code).toBe('READONLY_VIOLATION');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should enforce readonly even with other options set', async () => {
      mockGetToolRegistry.mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true, max_rows: 100 }),
      } as any);

      const handler = createExecuteSqlToolHandler('limited_source');
      const result = await handler({ sql: "DELETE FROM users" }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });

    it('should reject comment-only SQL in readonly mode', async () => {
      const sql = '-- Just a comment\n/* Another */';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });

    it('should forward the connector dialect to the classifier (MySQL conditional comment bypass)', async () => {
      const mysqlConnector = createMockConnector('mysql', 'mysql_source');
      mockGetCurrentConnector.mockReturnValue(mysqlConnector);

      const sql = 'SELECT 1; /*!50000 DROP TABLE users */';
      const handler = createExecuteSqlToolHandler('mysql_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
    });
  });

  describe('edge cases', () => {
    it.each([
      ['empty string', ''],
      ['only semicolons and whitespace', '   ;  ;  ; '],
    ])('should handle %s', async (_, sql) => {
      const mockResult: SQLResult = { resultSets: [{ rows: [], rowCount: 0 }] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
    });
  });
});
