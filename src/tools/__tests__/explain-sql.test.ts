import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExplainSqlToolHandler } from '../explain-sql.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { requestStore } from '../../requests/index.js';
import type { Connector, ConnectorType, SQLResult } from '../../connectors/interface.js';

vi.mock('../../connectors/manager.js');

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

const parseToolResponse = (response: any) => JSON.parse(response.content[0].text);

describe('explain-sql tool', () => {
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);

  beforeEach(() => {
    // Single-source by default, so resolveTrackedToolName resolves to the
    // bare tool name; multi-source naming is covered separately below.
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(['test_source']);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('dialect-specific EXPLAIN text', () => {
    it.each([
      ['postgres', 'EXPLAIN SELECT * FROM users'],
      ['mysql', 'EXPLAIN SELECT * FROM users'],
      ['mariadb', 'EXPLAIN SELECT * FROM users'],
      ['sqlserver', 'EXPLAIN SELECT * FROM users'],
      ['sqlite', 'EXPLAIN QUERY PLAN SELECT * FROM users'],
    ] satisfies [ConnectorType, string][])('builds "%s" as expected for %s', async (dialect, expected) => {
      const mockConnector = createMockConnector(dialect, 'test_source');
      mockGetCurrentConnector.mockReturnValue(mockConnector);
      const mockResult: SQLResult = { rows: [{ plan: 'x' }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExplainSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT * FROM users' }, null);
      const parsed = parseToolResponse(result);

      expect(parsed.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(expected, { readonly: true });
    });
  });

  describe('input validation', () => {
    let mockConnector: Connector;

    beforeEach(() => {
      mockConnector = createMockConnector('postgres', 'test_source');
      mockGetCurrentConnector.mockReturnValue(mockConnector);
    });

    it('rejects multiple statements', async () => {
      const handler = createExplainSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT 1; SELECT 2' }, null);

      expect(result.isError).toBe(true);
      const parsed = parseToolResponse(result);
      expect(parsed.code).toBe('INVALID_INPUT');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('rejects input already starting with EXPLAIN', async () => {
      const handler = createExplainSqlToolHandler('test_source');
      const result = await handler({ sql: 'EXPLAIN SELECT * FROM users' }, null);

      expect(result.isError).toBe(true);
      expect(parseToolResponse(result).code).toBe('INVALID_INPUT');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('rejects input starting with ANALYZE to prevent smuggled execution', async () => {
      const handler = createExplainSqlToolHandler('test_source');
      const result = await handler({ sql: 'ANALYZE DELETE FROM users' }, null);

      expect(result.isError).toBe(true);
      expect(parseToolResponse(result).code).toBe('INVALID_INPUT');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it.each([
      '(ANALYZE) DELETE FROM users',
      '(ANALYZE, VERBOSE) DELETE FROM users',
      '(VERBOSE,ANALYZE)DELETE FROM users',
      '-- comment\n(ANALYZE) DELETE FROM users',
    ])('rejects a leading parenthesized option list containing ANALYZE: %s', async (sql) => {
      const handler = createExplainSqlToolHandler('test_source');
      const result = await handler({ sql }, null);

      expect(result.isError).toBe(true);
      expect(parseToolResponse(result).code).toBe('INVALID_INPUT');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('allows a leading parenthesized option list that does not contain ANALYZE', async () => {
      const mockResult: SQLResult = { rows: [{ plan: 'x' }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExplainSqlToolHandler('test_source');
      const result = await handler({ sql: '(FORMAT JSON) SELECT * FROM users' }, null);

      expect(parseToolResponse(result).success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(
        'EXPLAIN (FORMAT JSON) SELECT * FROM users',
        { readonly: true }
      );
    });

    it('allows explaining a write statement (plain EXPLAIN never executes it)', async () => {
      const mockResult: SQLResult = { rows: [{ plan: 'x' }], rowCount: 1 };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const handler = createExplainSqlToolHandler('test_source');
      const result = await handler({ sql: 'DELETE FROM users WHERE id = 1' }, null);

      expect(parseToolResponse(result).success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(
        'EXPLAIN DELETE FROM users WHERE id = 1',
        { readonly: true }
      );
    });
  });

  describe('request tracking', () => {
    it('tracks the bare tool name for a single source configured with --id (not "default")', async () => {
      vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(['prod']);
      const mockConnector = createMockConnector('postgres', 'prod');
      mockGetCurrentConnector.mockReturnValue(mockConnector);
      vi.mocked(mockConnector.executeSQL).mockResolvedValue({ rows: [], rowCount: 0 });
      const addSpy = vi.spyOn(requestStore, 'add');

      const handler = createExplainSqlToolHandler('prod');
      await handler({ sql: 'SELECT 1' }, null);

      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'explain_sql' }));
    });

    it('tracks the normalized, suffixed tool name for a multi-source id with special characters', async () => {
      vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(['prod-pg', 'staging']);
      const mockConnector = createMockConnector('postgres', 'prod-pg');
      mockGetCurrentConnector.mockReturnValue(mockConnector);
      vi.mocked(mockConnector.executeSQL).mockResolvedValue({ rows: [], rowCount: 0 });
      const addSpy = vi.spyOn(requestStore, 'add');

      const handler = createExplainSqlToolHandler('prod-pg');
      await handler({ sql: 'SELECT 1' }, null);

      expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'explain_sql_prod_pg' }));
    });
  });

  describe('error handling', () => {
    it('returns EXECUTION_ERROR when the connector throws', async () => {
      const mockConnector = createMockConnector('postgres', 'test_source');
      mockGetCurrentConnector.mockReturnValue(mockConnector);
      vi.mocked(mockConnector.executeSQL).mockRejectedValue(new Error('boom'));

      const handler = createExplainSqlToolHandler('test_source');
      const result = await handler({ sql: 'SELECT 1' }, null);

      expect(result.isError).toBe(true);
      const parsed = parseToolResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('boom');
      expect(parsed.code).toBe('EXECUTION_ERROR');
    });
  });
});
