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
      expect(parsedResult.error).toBe('Database error');
      expect(parsedResult.code).toBe('EXECUTION_ERROR');
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
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should reject multi-statement with any write operation', async () => {
      const sql = "SELECT * FROM users; INSERT INTO users (name) VALUES ('test');";
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(result.isError).toBe(true);
      expect(parseToolResponse(result).code).toBe('READONLY_VIOLATION');
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
      ['only comments', '-- Just a comment\n/* Another */'],
    ])('should allow SELECT with %s', async (_, sql) => {
      const mockResult: SQLResult = { rows: [], rowCount: 0 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(parseToolResponse(result).success).toBe(true);
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
