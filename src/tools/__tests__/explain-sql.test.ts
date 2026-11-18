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
    ] satisfies [ConnectorType, string][])('on %s, runs "%s" read-only', async (dialect, expected) => {
      useConnector(dialect);

      const { parsed } = await explain('SELECT * FROM users');

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
      // ...in a leading parenthesized option list
      '(ANALYZE) DELETE FROM users',
      '(ANALYZE, VERBOSE) DELETE FROM users',
      '(VERBOSE,ANALYZE)DELETE FROM users',
      '-- comment\n(ANALYZE) DELETE FROM users',
      // PostgreSQL accepts ANALYSE as a synonym, and reads the keyword even
      // when it is glued to the parenthesis that follows (#501).
      'ANALYSE SELECT * FROM users',
      'ANALYSE VERBOSE SELECT * FROM users',
      'analyse DELETE FROM users',
      'ANALYZE(SELECT * FROM users)',
      'ANALYSE(SELECT * FROM users)',
      '(ANALYSE) SELECT * FROM users',
      '(VERBOSE, ANALYSE true) SELECT * FROM users',
      '(ANALYZE false) SELECT * FROM users',
    ])('rejects ANALYZE in any position or spelling: %s', async (sql) => {
      await expectInvalidInput(sql, 'ANALYZE');
    });

    // A quoted option name is still the option to PostgreSQL, so an option
    // list is only accepted when every name in it is recognized as written.
    it.each([
      '("analyze") SELECT * FROM users',
      '("analyze" true) SELECT * FROM users',
      '(VERBOSE, "analyze") SELECT * FROM users',
      '(U&"\\0061nalyze") SELECT * FROM users',
      '(RUN_IT) SELECT * FROM users',
      '() SELECT * FROM users',
    ])('rejects a leading option list with an unrecognized option: %s', async (sql) => {
      await expectInvalidInput(sql, 'only accepts these EXPLAIN options');
    });

    it.each([
      // Only looks like an option list or ANALYZE
      '(SELECT id FROM users) UNION (SELECT id FROM admins)',
      '(SELECT id, "analyze" FROM users) UNION (SELECT 1, 2)',
      '((SELECT 1)) UNION (SELECT 2)',
      '(VALUES (1)) UNION (VALUES (2))',
      'VERBOSE SELECT * FROM users',
      'SELECT analyse FROM users',
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
