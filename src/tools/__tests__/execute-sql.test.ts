import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExecuteSqlToolHandler } from '../execute-sql.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { isReadOnlyMode } from '../../config/env.js';
import type { Connector, ConnectorType, SQLResult } from '../../connectors/interface.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');
vi.mock('../../config/env.js');

// Mock connector for testing
const createMockConnector = (id: ConnectorType = 'sqlite'): Connector => ({
  id,
  name: 'Mock Connector',
  dsnParser: {} as any,
  connect: vi.fn(),
  disconnect: vi.fn(),
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
  const mockGetCurrentExecuteOptions = vi.mocked(ConnectorManager.getCurrentExecuteOptions);
  const mockIsReadOnlyMode = vi.mocked(isReadOnlyMode);

  beforeEach(() => {
    mockConnector = createMockConnector('sqlite');
    mockGetCurrentConnector.mockReturnValue(mockConnector);
    mockGetCurrentExecuteOptions.mockReturnValue({});
    mockIsReadOnlyMode.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('single statement execution', () => {
    it('should execute a single SELECT statement successfully', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1, name: 'test' }] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(parsedResult.data.rows).toEqual([{ id: 1, name: 'test' }]);
      expect(parsedResult.data.count).toBe(1);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT * FROM users', {});
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

  describe('multi-statement execution', () => {
    it('should pass multi-statement SQL directly to connector', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1 }] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT * FROM users; SELECT * FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, {});
    });
  });

  describe('read-only mode validation', () => {
    beforeEach(() => {
      mockIsReadOnlyMode.mockReturnValue(true);
    });

    it('should allow single SELECT statement in read-only mode', async () => {
      const mockResult: SQLResult = { rows: [{ id: 1 }] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalled();
    });

    it('should allow multiple read-only statements in read-only mode', async () => {
      const mockResult: SQLResult = { rows: [] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT * FROM users; SELECT * FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, {});
    });

    it('should reject single INSERT statement in read-only mode', async () => {
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: "INSERT INTO users (name) VALUES ('test')" }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.success).toBe(false);
      expect(parsedResult.error).toContain('Read-only mode is enabled');
      expect(parsedResult.code).toBe('READONLY_VIOLATION');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should reject multi-statement with any write operation in read-only mode', async () => {
      const sql = "SELECT * FROM users; INSERT INTO users (name) VALUES ('test'); SELECT COUNT(*) FROM users;";
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.success).toBe(false);
      expect(parsedResult.error).toContain('Read-only mode is enabled');
      expect(parsedResult.code).toBe('READONLY_VIOLATION');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

  });

  describe('SQL comments handling', () => {
    it('should allow SELECT with single-line comment in read-only mode', async () => {
      mockIsReadOnlyMode.mockReturnValue(true);
      const mockResult: SQLResult = { rows: [{ id: 1 }] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = '-- Fetch active users\nSELECT * FROM users WHERE active = TRUE';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, {});
    });

    it('should allow SELECT with multi-line comment in read-only mode', async () => {
      mockIsReadOnlyMode.mockReturnValue(true);
      const mockResult: SQLResult = { rows: [] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = '/* This query fetches\n   all products */\nSELECT * FROM products';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, {});
    });

    it('should handle multiple statements with comments in read-only mode', async () => {
      mockIsReadOnlyMode.mockReturnValue(true);
      const mockResult: SQLResult = { rows: [] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = '-- First query\nSELECT * FROM users;\n/* Second query */\nSELECT * FROM roles;';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, {});
    });

    it('should reject INSERT with comment in read-only mode', async () => {
      mockIsReadOnlyMode.mockReturnValue(true);

      const sql = '-- Insert new user\nINSERT INTO users (name) VALUES (\'test\')';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(result.isError).toBe(true);
      const parsedResult = parseToolResponse(result);
      expect(parsedResult.success).toBe(false);
      expect(parsedResult.code).toBe('READONLY_VIOLATION');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should handle query that is only comments as read-only', async () => {
      mockIsReadOnlyMode.mockReturnValue(true);
      const mockResult: SQLResult = { rows: [] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = '-- Just a comment\n/* Another comment */';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, {});
    });

    it('should handle inline comments correctly', async () => {
      mockIsReadOnlyMode.mockReturnValue(true);
      const mockResult: SQLResult = { rows: [] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT id, -- user id\n       name -- user name\nFROM users';
      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, {});
    });
  });


  describe('edge cases', () => {
    it('should handle empty SQL string', async () => {
      const mockResult: SQLResult = { rows: [] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: '' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('', {});
    });

    it('should handle SQL with only semicolons and whitespace', async () => {
      const mockResult: SQLResult = { rows: [] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExecuteSqlToolHandler('test_source');
      const result = await handler({ sql: '   ;  ;  ; ' }, null);
      const parsedResult = parseToolResponse(result);

      expect(parsedResult.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('   ;  ;  ; ', {});
    });
  });
});