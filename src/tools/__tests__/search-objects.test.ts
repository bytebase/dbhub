import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSearchDatabaseObjectsToolHandler } from '../search-objects.js';
import { ConnectorManager } from '../../connectors/manager.js';
import type { Connector, TableColumn, TableIndex } from '../../connectors/interface.js';
import { createMockConnector, describeRequestTracking, parseToolResponse } from './helpers.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');

// Fixture factories
const col = (
  column_name: string,
  data_type: string,
  is_nullable: 'YES' | 'NO' = 'YES',
  description: string | null = null
): TableColumn => ({ column_name, data_type, is_nullable, column_default: null, description });

const idx = (
  index_name: string,
  column_names: string[],
  is_unique: boolean,
  is_primary: boolean
): TableIndex => ({ index_name, column_names, is_unique, is_primary });

// Resolve a per-table mock (getTableSchema / getTableIndexes) from a lookup map
const byTable =
  <T>(map: Record<string, T[]>) =>
  async (table: string) =>
    map[table] ?? [];

const idColumn = col('id', 'INTEGER', 'NO');
const usersColumns: TableColumn[] = [idColumn, col('name', 'TEXT'), col('email', 'TEXT')];
const ordersColumns: TableColumn[] = [idColumn, col('user_id', 'INTEGER', 'NO')];
const usersPkey = idx('users_pkey', ['id'], true, true);
const usersEmailIdx = idx('users_email_idx', ['email'], true, false);
const usersIndexes: TableIndex[] = [usersPkey, usersEmailIdx];
const ordersIndexes: TableIndex[] = [idx('orders_pkey', ['id'], true, true)];

const countResult = (count: number) => ({ resultSets: [{ rows: [{ count }], rowCount: 1 }] });

describe('search_database_objects tool', () => {
  let mockConnector: Connector;
  let handler: ReturnType<typeof createSearchDatabaseObjectsToolHandler>;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);

  // Run the default-source handler and parse its response
  const search = async (args: Record<string, unknown>) => {
    const result: any = await handler(args, null);
    return { result, parsed: parseToolResponse(result) };
  };

  beforeEach(() => {
    // Single-source by default, so resolveTrackedToolName resolves to the
    // bare tool name; multi-source naming is covered separately below.
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(['default']);
    mockConnector = createMockConnector('sqlite');
    // One schema holding two tables, unless a test arranges otherwise
    vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);
    vi.mocked(mockConnector.getTables).mockResolvedValue(['users', 'orders']);
    mockGetCurrentConnector.mockReturnValue(mockConnector);
    handler = createSearchDatabaseObjectsToolHandler();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('search schemas', () => {
    beforeEach(() => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue([
        'public',
        'private',
        'production',
        'development',
        'test',
      ]);
    });

    it('should search schemas with pattern', async () => {
      const { parsed } = await search({ object_type: 'schema', pattern: 'p%', detail_level: 'names' });
      expect(parsed.success).toBe(true);
      expect(parsed.data.count).toBe(3);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual([
        'public',
        'private',
        'production',
      ]);
    });

    it('should respect limit parameter', async () => {
      const { parsed } = await search({ object_type: 'schema', pattern: '%', detail_level: 'names', limit: 2 });
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.truncated).toBe(true);
    });

    it('should return summary with table counts', async () => {
      vi.mocked(mockConnector.getTables).mockResolvedValue(['users', 'orders']);

      const { parsed } = await search({ object_type: 'schema', pattern: 'public', detail_level: 'summary' });
      expect(parsed.data.results[0]).toEqual({
        name: 'public',
        table_count: 2,
      });
    });
  });

  // searchTables and searchViews are separate implementations of the same
  // lookup, so each is driven through the same cases.
  describe.each([
    ['table', 'getTables'],
    ['view', 'getViews'],
  ] as const)('search %ss', (objectType, listMethod) => {
    beforeEach(() => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public', 'private']);
      vi.mocked(mockConnector[listMethod]).mockImplementation(async (schema?: string) =>
        schema === 'public' ? ['users', 'user_profiles', 'active_users'] : ['secrets']
      );
    });

    it('should match names against the pattern', async () => {
      const { parsed } = await search({ object_type: objectType, pattern: 'user%', detail_level: 'names' });
      expect(parsed.success).toBe(true);
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.results).toEqual([
        { name: 'users', schema: 'public' },
        { name: 'user_profiles', schema: 'public' },
      ]);
    });

    it('should list everything, across schemas, when pattern is omitted', async () => {
      const { parsed } = await search({ object_type: objectType, detail_level: 'names' });
      expect(parsed.data.count).toBe(4);
      expect(parsed.data.results).toEqual([
        { name: 'users', schema: 'public' },
        { name: 'user_profiles', schema: 'public' },
        { name: 'active_users', schema: 'public' },
        { name: 'secrets', schema: 'private' },
      ]);
    });

    it('should filter by schema parameter', async () => {
      const { parsed } = await search({ object_type: objectType, pattern: '%', schema: 'public', detail_level: 'names' });
      expect(parsed.data.count).toBe(3);
      expect(mockConnector[listMethod]).toHaveBeenCalledWith('public');
      expect(mockConnector[listMethod]).not.toHaveBeenCalledWith('private');
    });
  });

  describe('table details', () => {
    it('should return summary with metadata, falling back to COUNT(*) when connector lacks getTableRowCount', async () => {
      vi.mocked(mockConnector.getTableSchema).mockResolvedValue([idColumn, col('name', 'TEXT')]);
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(countResult(100));
      mockConnector.getTableComment = vi.fn().mockResolvedValue('Application users');

      const { parsed } = await search({ object_type: 'table', pattern: 'users', detail_level: 'summary' });
      expect(parsed.data.results[0]).toEqual({
        name: 'users',
        schema: 'public',
        column_count: 2,
        row_count: 100,
        comment: 'Application users',
      });
      // Default mock connector has no getTableRowCount, so the COUNT(*) path
      // runs, read-only like everything else this tool executes
      expect(mockConnector.executeSQL).toHaveBeenCalledWith(expect.stringContaining('COUNT(*)'), {
        maxRows: 1,
        readonly: true,
      });
    });

    it.each(['summary', 'full'])('should omit table comment at %s level when getTableComment returns null', async (detailLevel) => {
      vi.mocked(mockConnector.getTableSchema).mockResolvedValue([idColumn]);
      vi.mocked(mockConnector.getTableIndexes).mockResolvedValue([]);
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(countResult(10));
      mockConnector.getTableComment = vi.fn().mockResolvedValue(null);

      const { parsed } = await search({ object_type: 'table', pattern: 'users', detail_level: detailLevel });
      expect(parsed.data.results[0]).toMatchObject({ name: 'users', row_count: 10 });
      expect(parsed.data.results[0]).not.toHaveProperty('comment');
    });

    it.each([
      ['its estimate', 42],
      ['null, without falling back to COUNT(*)', null],
    ])('should take row_count from connector.getTableRowCount when implemented: %s', async (_, rowCount) => {
      vi.mocked(mockConnector.getTableSchema).mockResolvedValue([idColumn]);
      mockConnector.getTableRowCount = vi.fn().mockResolvedValue(rowCount);

      const { parsed } = await search({ object_type: 'table', pattern: 'users', detail_level: 'summary' });
      expect(parsed.success).toBe(true);
      expect(parsed.data.results[0]).toMatchObject({ name: 'users', row_count: rowCount });
      expect(mockConnector.getTableRowCount).toHaveBeenCalledWith('users', 'public');
      expect(mockConnector.executeSQL).not.toHaveBeenCalled();
    });

    it('should return full details with comment, columns (described where present) and indexes', async () => {
      vi.mocked(mockConnector.getTableSchema).mockResolvedValue([
        idColumn,
        col('name', 'TEXT', 'YES', 'Full name of the user'),
      ]);
      vi.mocked(mockConnector.getTableIndexes).mockResolvedValue([usersPkey]);
      vi.mocked(mockConnector.executeSQL).mockResolvedValue(countResult(50));
      mockConnector.getTableComment = vi.fn().mockResolvedValue('Application users');

      const { parsed } = await search({ object_type: 'table', pattern: 'users', detail_level: 'full' });
      expect(parsed.data.results[0]).toEqual({
        name: 'users',
        schema: 'public',
        column_count: 2,
        row_count: 50,
        comment: 'Application users',
        columns: [
          // A column without a description does not carry the field
          { name: 'id', type: 'INTEGER', nullable: false, default: null },
          { name: 'name', type: 'TEXT', nullable: true, default: null, description: 'Full name of the user' },
        ],
        indexes: [{ name: 'users_pkey', columns: ['id'], unique: true, primary: true }],
      });
      expect(parsed.data.results[0].columns[0]).not.toHaveProperty('description');
    });
  });

  describe('view details', () => {
    beforeEach(() => {
      vi.mocked(mockConnector.getViews).mockResolvedValue(['active_users']);
    });

    it('should return summary with column count and comment', async () => {
      vi.mocked(mockConnector.getTableSchema).mockResolvedValue([idColumn, col('name', 'TEXT')]);
      mockConnector.getTableComment = vi.fn().mockResolvedValue('Users with recent activity');

      const { parsed } = await search({ object_type: 'view', pattern: 'active_users', detail_level: 'summary' });
      expect(parsed.data.results[0]).toEqual({
        name: 'active_users',
        schema: 'public',
        column_count: 2,
        comment: 'Users with recent activity',
      });
    });

    it('should return full details with columns and an empty indexes array without querying indexes', async () => {
      vi.mocked(mockConnector.getTableSchema).mockResolvedValue([idColumn]);

      const { parsed } = await search({ object_type: 'view', pattern: 'active_users', detail_level: 'full' });
      expect(parsed.data.results[0]).toMatchObject({
        name: 'active_users',
        schema: 'public',
        column_count: 1,
        indexes: [],
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, default: null },
        ],
      });
      // getTableIndexes throws for views on some engines; it must not be called.
      expect(mockConnector.getTableIndexes).not.toHaveBeenCalled();
    });
  });

  describe('search columns', () => {
    it('should search columns across tables', async () => {
      vi.mocked(mockConnector.getTableSchema).mockImplementation(
        byTable({ users: usersColumns, orders: ordersColumns })
      );

      const { parsed } = await search({ object_type: 'column', pattern: '%id', detail_level: 'names' });
      expect(parsed.data.count).toBe(3);
      expect(parsed.data.results).toEqual([
        { name: 'id', table: 'users', schema: 'public' },
        { name: 'id', table: 'orders', schema: 'public' },
        { name: 'user_id', table: 'orders', schema: 'public' },
      ]);
    });

    it('should also search columns of views', async () => {
      vi.mocked(mockConnector.getTables).mockResolvedValue(['users']);
      vi.mocked(mockConnector.getViews).mockResolvedValue(['active_users']);

      // Both the table and the view expose a user_id column.
      vi.mocked(mockConnector.getTableSchema).mockResolvedValue([col('user_id', 'INTEGER', 'NO')]);

      const { parsed } = await search({ object_type: 'column', pattern: 'user_id', detail_level: 'names' });
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.results).toEqual([
        { name: 'user_id', table: 'users', schema: 'public' },
        { name: 'user_id', table: 'active_users', schema: 'public' },
      ]);
    });

    it('should still return table columns when getViews is unsupported', async () => {
      vi.mocked(mockConnector.getTables).mockResolvedValue(['users']);
      vi.mocked(mockConnector.getViews).mockRejectedValue(new Error('views not supported'));
      vi.mocked(mockConnector.getTableSchema).mockResolvedValue([col('email', 'TEXT')]);

      const { parsed } = await search({ object_type: 'column', pattern: 'email', detail_level: 'names' });
      expect(parsed.data.count).toBe(1);
      expect(parsed.data.results).toEqual([{ name: 'email', table: 'users', schema: 'public' }]);
    });

    it('should return column details in summary level', async () => {
      vi.mocked(mockConnector.getTableSchema).mockResolvedValue([col('email', 'VARCHAR(255)')]);

      const { parsed } = await search({ object_type: 'column', pattern: 'email', detail_level: 'summary' });
      expect(parsed.data.results[0]).toEqual({
        name: 'email',
        table: 'users',
        schema: 'public',
        type: 'VARCHAR(255)',
        nullable: true,
        default: null,
      });
    });
  });

  describe('search procedures and functions', () => {
    it.each([
      // [object_type, routines returned by connector, pattern, expected matches]
      ['procedure', ['get_user', 'get_users_by_email', 'delete_user'], 'get%', ['get_user', 'get_users_by_email']],
      ['function', ['calc_total', 'get_user_name'], '%', ['calc_total', 'get_user_name']],
    ])('should search %ss with pattern and pass the routine type to the connector', async (objectType, routines, pattern, expected) => {
      vi.mocked(mockConnector.getStoredProcedures).mockResolvedValue(routines);

      const { parsed } = await search({ object_type: objectType, pattern, detail_level: 'names' });
      expect(parsed.data.count).toBe(expected.length);
      expect(parsed.data.object_type).toBe(objectType);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual(expected);
      // Verify routineType filter is passed to connector
      expect(mockConnector.getStoredProcedures).toHaveBeenCalledWith('public', objectType);
    });

    const summary = { name: 'calc_total', schema: 'public', type: 'function', language: 'plpgsql', return_type: 'NUMERIC' };

    it.each([
      ['summary', summary],
      ['full', { ...summary, parameters: 'order_id INTEGER', definition: 'BEGIN RETURN 42; END;' }],
    ])('should return function details in %s level', async (detailLevel, expected) => {
      vi.mocked(mockConnector.getStoredProcedures).mockResolvedValue(['calc_total']);
      vi.mocked(mockConnector.getStoredProcedureDetail).mockResolvedValue({
        procedure_name: 'calc_total',
        procedure_type: 'function',
        language: 'plpgsql',
        parameter_list: 'order_id INTEGER',
        return_type: 'NUMERIC',
        definition: 'BEGIN RETURN 42; END;',
      });

      const { parsed } = await search({ object_type: 'function', pattern: 'calc_total', detail_level: detailLevel });
      // Exact match: parameters and definition are only present at the full level
      expect(parsed.data.results).toEqual([expected]);
    });
  });

  describe('search indexes', () => {
    it('should search indexes across tables', async () => {
      vi.mocked(mockConnector.getTableIndexes).mockImplementation(
        byTable({ users: usersIndexes, orders: ordersIndexes })
      );

      const { parsed } = await search({ object_type: 'index', pattern: '%pkey', detail_level: 'names' });
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual([
        'users_pkey',
        'orders_pkey',
      ]);
    });

    it('should return index details in summary level', async () => {
      vi.mocked(mockConnector.getTableIndexes).mockResolvedValue([usersEmailIdx]);

      const { parsed } = await search({ object_type: 'index', pattern: '%email%', detail_level: 'summary' });
      expect(parsed.data.results[0]).toEqual({
        name: 'users_email_idx',
        table: 'users',
        schema: 'public',
        columns: ['email'],
        unique: true,
        primary: false,
      });
    });
  });

  describe('table filter', () => {
    const tableFilter = { pattern: '%', schema: 'public', table: 'users', detail_level: 'names' };

    it('should filter columns by table when table parameter is provided', async () => {
      vi.mocked(mockConnector.getTableSchema).mockImplementation(
        byTable({ users: [idColumn, col('name', 'TEXT')], orders: ordersColumns })
      );

      const { parsed } = await search({ object_type: 'column', ...tableFilter });
      expect(parsed.success).toBe(true);
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.results).toEqual([
        { name: 'id', table: 'users', schema: 'public' },
        { name: 'name', table: 'users', schema: 'public' },
      ]);
      // Verify only users table was queried
      expect(mockConnector.getTableSchema).toHaveBeenCalledWith('users', 'public');
      expect(mockConnector.getTableSchema).not.toHaveBeenCalledWith('orders', 'public');
    });

    it('should filter indexes by table when table parameter is provided', async () => {
      vi.mocked(mockConnector.getTableIndexes).mockImplementation(
        byTable({ users: usersIndexes, orders: ordersIndexes })
      );

      const { parsed } = await search({ object_type: 'index', ...tableFilter });
      expect(parsed.success).toBe(true);
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual(['users_pkey', 'users_email_idx']);
      // Verify only users table was queried
      expect(mockConnector.getTableIndexes).toHaveBeenCalledWith('users', 'public');
      expect(mockConnector.getTableIndexes).not.toHaveBeenCalledWith('orders', 'public');
    });

    it('should require schema when table is specified', async () => {
      const { result, parsed } = await search({ object_type: 'column', ...tableFilter, schema: undefined });
      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('SCHEMA_REQUIRED');
      expect(parsed.error).toContain("'table' parameter requires 'schema'");
    });

    it.each(['schema', 'table', 'procedure', 'function'])(
      'should reject table parameter for %s object type',
      async (objectType) => {
        const { result, parsed } = await search({ object_type: objectType, ...tableFilter });
        expect(result.isError).toBe(true);
        expect(parsed.code).toBe('INVALID_TABLE_FILTER');
        expect(parsed.error).toContain("only applies to object_type 'column' or 'index'");
      }
    );
  });

  // Connection-failure classification happens in runToolRequest, shared by
  // every tool; it is covered once, in execute-sql.test.ts.
  describe('error handling', () => {
    it('should validate schema exists', async () => {
      const { result, parsed } = await search({
        object_type: 'table',
        pattern: '%',
        schema: 'nonexistent',
        detail_level: 'names',
      });
      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('SCHEMA_NOT_FOUND');
    });

    it('should handle connector errors gracefully', async () => {
      vi.mocked(mockConnector.getSchemas).mockRejectedValue(new Error('Connection failed'));

      const { result, parsed } = await search({ object_type: 'schema', pattern: '%', detail_level: 'names' });
      expect(result.isError).toBe(true);
      expect(parsed.code).toBe('SEARCH_ERROR');
    });
  });

  describe('LIKE pattern matching', () => {
    beforeEach(() => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue([
        'table[1]',
        'table(prod)',
        'data.backup',
        'test+logs',
        'user*data',
        'test',
        'Public',
      ]);
    });

    it.each([
      // [description, pattern, expected matches]
      ['treat _ as a single-character wildcard', 't__t', ['test']],
      ['match case-insensitively', 'public', ['Public']],
      // Patterns containing regex special characters must match literally
      ['escape regex brackets', 'table[1]', ['table[1]']],
      ['escape regex parentheses', 'table(prod)', ['table(prod)']],
      ['escape regex dot', 'data.backup', ['data.backup']],
      ['escape regex plus', 'test+logs', ['test+logs']],
      ['escape regex asterisk (not a SQL wildcard)', 'user*data', ['user*data']],
    ])('should %s', async (_, pattern, expected) => {
      const { parsed } = await search({ object_type: 'schema', pattern, detail_level: 'names' });
      expect(parsed.data.results.map((r: any) => r.name)).toEqual(expected);
    });
  });

  describe('default schema scoping', () => {
    // Simulates a MySQL/MariaDB connector whose getSchemas() lists every
    // database on the server, but getDefaultSchema() reports the DSN-configured
    // database. Searches without an explicit schema must stay within the default.
    let getDefaultSchema: ReturnType<typeof vi.fn<() => Promise<string | null>>>;

    beforeEach(() => {
      getDefaultSchema = vi.fn();
      mockConnector = createMockConnector('mysql', 'default', { getDefaultSchema });
      mockGetCurrentConnector.mockReturnValue(mockConnector);
      vi.mocked(mockConnector.getSchemas).mockResolvedValue([
        'configured_db',
        'other_db',
        'third_db',
      ]);
      vi.mocked(mockConnector.getTables).mockImplementation(async (schema?: string) => {
        if (schema === 'configured_db') return ['orders'];
        if (schema === 'other_db') return ['secrets'];
        return ['misc'];
      });
      vi.mocked(mockConnector.getViews).mockImplementation(async (schema?: string) => {
        if (schema === 'configured_db') return ['order_summary'];
        if (schema === 'other_db') return ['secret_view'];
        return ['misc_view'];
      });
    });

    it.each([
      // [object_type, connector method that lists it, expected name in configured_db]
      ['table', 'getTables', 'orders'],
      ['view', 'getViews', 'order_summary'],
    ] as const)(
      'scopes %s search to the default schema and never fans out to other databases',
      async (objectType, method, expectedName) => {
        getDefaultSchema.mockResolvedValue('configured_db');

        const { parsed } = await search({ object_type: objectType, pattern: '%', detail_level: 'names' });
        expect(parsed.data.results.map((r: any) => r.schema)).toEqual(['configured_db']);
        expect(parsed.data.results.map((r: any) => r.name)).toEqual([expectedName]);
        // Only the configured database should have been inspected.
        expect(mockConnector[method]).toHaveBeenCalledTimes(1);
        expect(mockConnector[method]).toHaveBeenCalledWith('configured_db');
      }
    );

    it.each(['table', 'view'])(
      'falls back to the full schema list for %ss when no default is configured (null)',
      async (objectType) => {
        getDefaultSchema.mockResolvedValue(null);

        const { parsed } = await search({ object_type: objectType, pattern: '%', detail_level: 'names' });
        expect(parsed.data.results.map((r: any) => r.schema)).toEqual([
          'configured_db',
          'other_db',
          'third_db',
        ]);
      }
    );

    it('scopes schema listing to the default schema', async () => {
      getDefaultSchema.mockResolvedValue('configured_db');

      const { parsed } = await search({ object_type: 'schema', pattern: '%', detail_level: 'names' });
      expect(parsed.data.results.map((r: any) => r.name)).toEqual(['configured_db']);
    });

    it('honors an explicit schema filter targeting a non-default database', async () => {
      getDefaultSchema.mockResolvedValue('configured_db');

      const { parsed } = await search({ object_type: 'table', pattern: '%', schema: 'other_db', detail_level: 'names' });
      expect(parsed.data.results.map((r: any) => r.schema)).toEqual(['other_db']);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual(['secrets']);
      // getDefaultSchema must not override an explicit caller-provided schema.
      expect(getDefaultSchema).not.toHaveBeenCalled();
    });
  });

  describeRequestTracking('search_objects', (sourceId) =>
    createSearchDatabaseObjectsToolHandler(sourceId)({ object_type: 'schema', pattern: '%', detail_level: 'names' }, null)
  );
});
