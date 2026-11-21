import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExplainSqlToolHandler } from '../explain-sql.js';
import { ConnectorManager } from '../../connectors/manager.js';
import type { Connector, ConnectorType, SQLResult } from '../../connectors/interface.js';
import { createMockConnector, describeRequestTracking, parseToolResponse } from './helpers.js';

vi.mock('../../connectors/manager.js');

const planResult: SQLResult = { resultSets: [{ rows: [{ plan: 'x' }], rowCount: 1 }] };

describe('explain-sql tool', () => {
  let mockConnector: Connector;

  // Bind the mocked manager to a connector of the given dialect
  const useConnector = (dialect: ConnectorType, sourceId: string = 'test_source') => {
    mockConnector = createMockConnector(dialect, sourceId);
    vi.mocked(mockConnector.executeSQL).mockResolvedValue(planResult);
    vi.mocked(ConnectorManager.getCurrentConnector).mockReturnValue(mockConnector);
  };

  const explain = async (sql: string) => {
    const result: any = await createExplainSqlToolHandler('test_source')({ sql }, null);
    return { result, parsed: parseToolResponse(result) };
  };

  // The input must be refused, for the stated reason, before anything
  // reaches the database
  const expectInvalidInput = async (sql: string, messagePart: string) => {
    const { result, parsed } = await explain(sql);

    expect(result.isError).toBe(true);
    expect(parsed.code).toBe('INVALID_INPUT');
    expect(parsed.error).toContain(messagePart);
    expect(mockConnector.executeSQL).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    // Single-source by default, so resolveTrackedToolName resolves to the
    // bare tool name; multi-source naming is covered separately below.
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(['test_source']);
    useConnector('postgres');
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
      ['clickhouse', 'EXPLAIN indexes = 1 SELECT * FROM users'],
    ] satisfies [ConnectorType, string][])('on %s, runs "%s" read-only', async (dialect, expected) => {
      useConnector(dialect);

      const { parsed } = await explain('SELECT * FROM users');

      expect(parsed.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(expected, { readonly: true });
    });
  });

  describe('ClickHouse', () => {
    it.each([
      ['a WITH query', 'WITH 1 AS x SELECT x', 'EXPLAIN indexes = 1 WITH 1 AS x SELECT x'],
      ['a parenthesized query', '(SELECT 1) UNION ALL (SELECT 2)', 'EXPLAIN indexes = 1 (SELECT 1) UNION ALL (SELECT 2)'],
      ['a query behind a comment', '-- why slow?\nSELECT 1', 'EXPLAIN indexes = 1 -- why slow?\nSELECT 1'],
      // The caller chose the kind of EXPLAIN or its settings: nothing is added
      ['an EXPLAIN kind', 'PIPELINE SELECT 1', 'EXPLAIN PIPELINE SELECT 1'],
      ['ESTIMATE', 'ESTIMATE SELECT * FROM events', 'EXPLAIN ESTIMATE SELECT * FROM events'],
      ['EXPLAIN settings', 'actions = 1 SELECT 1', 'EXPLAIN actions = 1 SELECT 1'],
    ])('explains %s with index analysis only where it is a plain query', async (_label, sql, expected) => {
      useConnector('clickhouse');

      const { parsed } = await explain(sql);

      expect(parsed.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(expected, { readonly: true });
    });
  });

  describe('input validation', () => {
    it('rejects multiple statements', async () => {
      await expectInvalidInput('SELECT 1; SELECT 2', 'single SQL statement');
    });

    it.each([
      ['mysql', String.raw`SELECT '\' , '; DROP TABLE t; SELECT ''`],
      // Hidden only when the server runs with NO_BACKSLASH_ESCAPES
      ['mariadb', String.raw`SELECT '\'; DROP TABLE t; SELECT ''`],
      ['postgres', String.raw`SELECT E'\' , '; DROP TABLE t; SELECT ''`],
    ] satisfies [ConnectorType, string][])(
      'rejects a %s statement hidden by a backslash-escaped quote',
      async (dialect, sql) => {
        useConnector(dialect);
        await expectInvalidInput(sql, 'single SQL statement');
      }
    );

    it('rejects input already starting with EXPLAIN', async () => {
      await expectInvalidInput('EXPLAIN SELECT * FROM users', 'must not itself start with EXPLAIN');
    });

    // Our own EXPLAIN prefix must never combine with the input into a form
    // that executes the statement.
    it.each([
      'ANALYZE DELETE FROM users',
      '(ANALYZE false) SELECT * FROM users',
      String.raw`(U&"\0061nalyze") SELECT * FROM users`,
    ])('rejects ANALYZE even when disabled or quoted: %s', async (sql) => {
      await expectInvalidInput(sql, 'ANALYZE');
    });

    it('rejects unknown EXPLAIN options', async () => {
      await expectInvalidInput('(RUN_IT) SELECT 1', 'only accepts these EXPLAIN options');
    });

    it.each(['() SELECT 1'])(
      'rejects invalid PostgreSQL syntax: %s', async (sql) => {
        await expectInvalidInput(sql, 'valid PostgreSQL EXPLAIN syntax');
      }
    );

    it.each([
      // Only looks like an option list or ANALYZE
      '(SELECT id FROM users) UNION (SELECT id FROM admins)',
      'SELECT "analyse" FROM users',
      // A leading option list that does not contain ANALYZE
      '(FORMAT JSON) SELECT * FROM users',
      // A write statement: plain EXPLAIN never executes it
      'DELETE FROM users WHERE id = 1',
    ])('allows: %s', async (sql) => {
      const { parsed } = await explain(sql);

      expect(parsed.success).toBe(true);
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(`EXPLAIN ${sql}`, { readonly: true });
    });
  });

  describeRequestTracking('explain_sql', async (sourceId) => {
    useConnector('postgres', sourceId);
    await createExplainSqlToolHandler(sourceId)({ sql: 'SELECT 1' }, null);
  });
});
