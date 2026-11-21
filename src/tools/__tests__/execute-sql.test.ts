import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExecuteSqlToolHandler } from '../execute-sql.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { getToolRegistry } from '../registry.js';
import type { Connector, SQLResult } from '../../connectors/interface.js';
import { createMockConnector, describeRequestTracking, parseToolResponse } from './helpers.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');
vi.mock('../registry.js');

describe('execute-sql tool', () => {
  let mockConnector: Connector;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);
  const mockGetToolRegistry = vi.mocked(getToolRegistry);

  // Run a handler (bound to test_source unless given) and parse its response
  const execute = async (sql: string, handler = createExecuteSqlToolHandler('test_source')) => {
    const result: any = await handler({ sql }, null);
    return { result, parsed: parseToolResponse(result) };
  };

  beforeEach(() => {
    mockConnector = createMockConnector('sqlite');
    // Single-source by default, so resolveTrackedToolName resolves to the
    // bare tool name; multi-source naming is covered separately below.
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(['test_source']);
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
    it('should pass the SQL to the connector unchanged and return one entry per statement', async () => {
      const mockResult: SQLResult = {
        resultSets: [
          { sql: 'SELECT * FROM users', rows: [{ id: 1, name: 'test' }], rowCount: 1 },
          // Capped by max_rows: flagged, so it can be told from a complete result
          { sql: 'SELECT * FROM roles', rows: [{ id: 2 }, { id: 3 }], rowCount: 2, truncated: true },
        ],
      };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const sql = 'SELECT * FROM users; SELECT * FROM roles;';
      const { parsed } = await execute(sql);

      expect(parsed.success).toBe(true);
      expect(parsed.data.statements).toEqual([
        { sql: 'SELECT * FROM users', rows: [{ id: 1, name: 'test' }], count: 1 },
        { sql: 'SELECT * FROM roles', rows: [{ id: 2 }, { id: 3 }], count: 2, truncated: true },
      ]);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(sql, { readonly: false, maxRows: undefined });
    });
  });

  // Error shaping and connection-failure classification live in
  // runToolRequest, the shell every tool handler runs in. They are covered
  // here once rather than per tool.
  describe('error handling', () => {
    it('should handle execution errors', async () => {
      vi.mocked(mockConnector.executeSQL).mockRejectedValue(new Error('Database error'));

      const { result, parsed } = await execute('SELECT * FROM invalid_table');

      expect(result.isError).toBe(true);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Database error');
      expect(parsed.code).toBe('EXECUTION_ERROR');
    });

    // Wire a connector whose executeSQL fails with a network error, plus the
    // source config the connection-error classifier looks up for it.
    const mockUnreachable = (sourceId: string, sourceConfig: unknown) => {
      const econn: any = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      econn.code = 'ECONNREFUSED';
      mockGetCurrentConnector.mockReturnValue({
        id: 'postgres',
        getId: () => sourceId,
        executeSQL: vi.fn().mockRejectedValue(econn),
      } as any);
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue(sourceConfig as any);
    };

    it.each([
      ['a named source', 'prod', { id: 'prod', type: 'postgres' }, 'prod'],
      ['the unnamed single source, displayed as "default"', undefined, { type: 'postgres' }, 'default'],
    ])(
      'returns SOURCE_UNREACHABLE when the connector of %s throws a network error',
      async (_, sourceId, sourceConfig, displayId) => {
        mockUnreachable(displayId, sourceConfig);

        const { result, parsed } = await execute('SELECT 1', createExecuteSqlToolHandler(sourceId));

        expect(result.isError).toBe(true);
        expect(parsed.code).toBe('SOURCE_UNREACHABLE');
        expect(parsed.details.source_id).toBe(displayId);
      }
    );

    it('falls through to EXECUTION_ERROR when the source config is null', async () => {
      mockUnreachable('prod', null);

      const { result, parsed } = await execute('SELECT 1', createExecuteSqlToolHandler('prod'));

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('EXECUTION_ERROR');
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
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true, max_rows: 100 }),
      } as any);
    });

    it('should allow SELECT statements, passing readonly and max_rows on to the connector', async () => {
      const mockResult: SQLResult = { resultSets: [{ rows: [{ id: 1 }], rowCount: 1 }] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      const { parsed } = await execute('SELECT * FROM users');

      expect(parsed.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith('SELECT * FROM users', { readonly: true, maxRows: 100 });
    });

    it.each([
      ['a write statement', "INSERT INTO users (name) VALUES ('test')"],
      ['a multi-statement containing a write', 'SELECT 1; DROP TABLE t'],
    ])('should reject %s', async (_, sql) => {
      const { result, parsed } = await execute(sql);

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('READONLY_VIOLATION');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should say so when PostgreSQL SQL was refused because it could not be parsed', async () => {
      const postgres = createMockConnector('postgres', 'pg_source');
      mockGetCurrentConnector.mockReturnValue(postgres);

      const { result, parsed } = await execute(
        'SELECT * FORM users',
        createExecuteSqlToolHandler('pg_source')
      );

      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('READONLY_VIOLATION');
      expect(parsed.error).toContain('could not be parsed as PostgreSQL');
      expect(parsed.error).toContain('syntax error at or near "FORM" (position 10)');
      expect(postgres.executeSQL).not.toHaveBeenCalled();
    });

    it('should forward the connector dialect to the classifier (MySQL conditional comment bypass)', async () => {
      mockGetCurrentConnector.mockReturnValue(createMockConnector('mysql', 'mysql_source'));

      const { parsed } = await execute(
        'SELECT 1; /*!50000 DROP TABLE users */',
        createExecuteSqlToolHandler('mysql_source')
      );

      expect(parsed.code).toBe('READONLY_VIOLATION');
    });
  });

  describe('edge cases', () => {
    it.each([
      ['empty string', ''],
      ['only semicolons and whitespace', '   ;  ;  ; '],
    ])('should handle %s', async (_, sql) => {
      const mockResult: SQLResult = { resultSets: [{ rows: [], rowCount: 0 }] };
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(mockResult);

      expect((await execute(sql)).parsed.success).toBe(true);
    });
  });

  describeRequestTracking('execute_sql', async (sourceId) => {
    vi.mocked(mockConnector.executeSQL).mockResolvedValue({ resultSets: [{ rows: [], rowCount: 0 }] });
    await createExecuteSqlToolHandler(sourceId)({ sql: 'SELECT 1' }, null);
  });
});
