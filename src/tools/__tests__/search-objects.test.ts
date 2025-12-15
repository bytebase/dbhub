import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSearchDatabaseObjectsToolHandler } from '../search-objects.js';
import { ConnectorManager } from '../../connectors/manager.js';
import type { Connector, ConnectorType, TableColumn, TableIndex } from '../../connectors/interface.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');

// Mock connector for testing
const createMockConnector = (id: ConnectorType = 'sqlite'): Connector => ({
  id,
  name: 'Mock Connector',
  getId: () => 'default',
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

describe('search_database_objects tool', () => {
  let mockConnector: Connector;
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);

  beforeEach(() => {
    mockConnector = createMockConnector('sqlite');
    mockGetCurrentConnector.mockReturnValue(mockConnector);
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
      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'schema',
          pattern: 'p%',
          detail_level: 'names',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.data.count).toBe(3);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual([
        'public',
        'private',
        'production',
      ]);
    });

    it('should search schemas with _ wildcard', async () => {
      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'schema',
          pattern: 't__t',
          detail_level: 'names',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual(['test']);
    });

    it('should respect limit parameter', async () => {
      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'schema',
          pattern: '%',
          detail_level: 'names',
          limit: 2,
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.truncated).toBe(true);
    });

    it('should return summary with table counts', async () => {
      vi.mocked(mockConnector.getTables).mockResolvedValue(['users', 'orders']);

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'schema',
          pattern: 'public',
          detail_level: 'summary',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.results[0]).toEqual({
        name: 'public',
        table_count: 2,
      });
    });
  });

  describe('search tables', () => {
    beforeEach(() => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);
      vi.mocked(mockConnector.getTables).mockResolvedValue([
        'users',
        'user_profiles',
        'user_sessions',
        'orders',
        'products',
      ]);
    });

    it('should search tables with pattern', async () => {
      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'table',
          pattern: 'user%',
          detail_level: 'names',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.count).toBe(3);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual([
        'users',
        'user_profiles',
        'user_sessions',
      ]);
    });

    it('should filter by schema parameter', async () => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public', 'private']);
      vi.mocked(mockConnector.getTables).mockImplementation(async (schema) => {
        if (schema === 'public') return ['users', 'orders'];
        if (schema === 'private') return ['secrets'];
        return [];
      });

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'table',
          pattern: '%',
          schema: 'public',
          detail_level: 'names',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.count).toBe(2);
      expect(mockConnector.getTables).toHaveBeenCalledWith('public');
      expect(mockConnector.getTables).not.toHaveBeenCalledWith('private');
    });

    it('should return summary with metadata', async () => {
      const mockColumns: TableColumn[] = [
        { column_name: 'id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
        { column_name: 'name', data_type: 'TEXT', is_nullable: 'YES', column_default: null },
      ];

      vi.mocked(mockConnector.getTableSchema).mockResolvedValue(mockColumns);
      vi.mocked(mockConnector.executeSQL).mockResolvedValue({ rows: [{ count: 100 }] });

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'table',
          pattern: 'users',
          detail_level: 'summary',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.results[0]).toMatchObject({
        name: 'users',
        schema: 'public',
        column_count: 2,
        row_count: 100,
      });
    });

    it('should return full details with columns and indexes', async () => {
      const mockColumns: TableColumn[] = [
        { column_name: 'id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
      ];

      const mockIndexes: TableIndex[] = [
        {
          index_name: 'users_pkey',
          column_names: ['id'],
          is_unique: true,
          is_primary: true,
        },
      ];

      vi.mocked(mockConnector.getTableSchema).mockResolvedValue(mockColumns);
      vi.mocked(mockConnector.getTableIndexes).mockResolvedValue(mockIndexes);
      vi.mocked(mockConnector.executeSQL).mockResolvedValue({ rows: [{ count: 50 }] });

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'table',
          pattern: 'users',
          detail_level: 'full',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.results[0]).toMatchObject({
        name: 'users',
        columns: [
          {
            name: 'id',
            type: 'INTEGER',
            nullable: false,
            default: null,
          },
        ],
        indexes: [
          {
            name: 'users_pkey',
            columns: ['id'],
            unique: true,
            primary: true,
          },
        ],
      });
    });
  });

  describe('search columns', () => {
    beforeEach(() => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);
      vi.mocked(mockConnector.getTables).mockResolvedValue(['users', 'orders']);
    });

    it('should search columns across tables', async () => {
      const usersColumns: TableColumn[] = [
        { column_name: 'id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
        { column_name: 'name', data_type: 'TEXT', is_nullable: 'YES', column_default: null },
        { column_name: 'email', data_type: 'TEXT', is_nullable: 'YES', column_default: null },
      ];

      const ordersColumns: TableColumn[] = [
        { column_name: 'id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
        { column_name: 'user_id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
      ];

      vi.mocked(mockConnector.getTableSchema).mockImplementation(async (table) => {
        if (table === 'users') return usersColumns;
        if (table === 'orders') return ordersColumns;
        return [];
      });

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'column',
          pattern: '%id',
          detail_level: 'names',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.count).toBe(3);
      expect(parsed.data.results).toEqual([
        { name: 'id', table: 'users', schema: 'public' },
        { name: 'id', table: 'orders', schema: 'public' },
        { name: 'user_id', table: 'orders', schema: 'public' },
      ]);
    });

    it('should return column details in summary level', async () => {
      const columns: TableColumn[] = [
        { column_name: 'email', data_type: 'VARCHAR(255)', is_nullable: 'YES', column_default: null },
      ];

      vi.mocked(mockConnector.getTableSchema).mockResolvedValue(columns);

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'column',
          pattern: 'email',
          detail_level: 'summary',
        },
        null
      );

      const parsed = parseToolResponse(result);
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

  describe('search procedures', () => {
    beforeEach(() => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);
      vi.mocked(mockConnector.getStoredProcedures).mockResolvedValue([
        'get_user',
        'get_users_by_email',
        'delete_user',
      ]);
    });

    it('should search procedures with pattern', async () => {
      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'procedure',
          pattern: 'get%',
          detail_level: 'names',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual([
        'get_user',
        'get_users_by_email',
      ]);
    });

    it('should return procedure details in summary level', async () => {
      vi.mocked(mockConnector.getStoredProcedureDetail).mockResolvedValue({
        procedure_name: 'get_user',
        procedure_type: 'function',
        language: 'plpgsql',
        parameter_list: 'user_id INTEGER',
        return_type: 'TABLE',
      });

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'procedure',
          pattern: 'get_user',
          detail_level: 'summary',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.results[0]).toMatchObject({
        name: 'get_user',
        schema: 'public',
        type: 'function',
        return_type: 'TABLE',
      });
    });
  });

  describe('search indexes', () => {
    beforeEach(() => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);
      vi.mocked(mockConnector.getTables).mockResolvedValue(['users', 'orders']);
    });

    it('should search indexes across tables', async () => {
      const usersIndexes: TableIndex[] = [
        {
          index_name: 'users_pkey',
          column_names: ['id'],
          is_unique: true,
          is_primary: true,
        },
        {
          index_name: 'users_email_idx',
          column_names: ['email'],
          is_unique: true,
          is_primary: false,
        },
      ];

      const ordersIndexes: TableIndex[] = [
        {
          index_name: 'orders_pkey',
          column_names: ['id'],
          is_unique: true,
          is_primary: true,
        },
      ];

      vi.mocked(mockConnector.getTableIndexes).mockImplementation(async (table) => {
        if (table === 'users') return usersIndexes;
        if (table === 'orders') return ordersIndexes;
        return [];
      });

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'index',
          pattern: '%pkey',
          detail_level: 'names',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.count).toBe(2);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual([
        'users_pkey',
        'orders_pkey',
      ]);
    });

    it('should return index details in summary level', async () => {
      const indexes: TableIndex[] = [
        {
          index_name: 'users_email_idx',
          column_names: ['email'],
          is_unique: true,
          is_primary: false,
        },
      ];

      vi.mocked(mockConnector.getTableIndexes).mockResolvedValue(indexes);

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'index',
          pattern: '%email%',
          detail_level: 'summary',
        },
        null
      );

      const parsed = parseToolResponse(result);
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
    describe('for columns', () => {
      beforeEach(() => {
        vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);
      });

      it('should filter columns by table when table parameter is provided', async () => {
        const usersColumns: TableColumn[] = [
          { column_name: 'id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'TEXT', is_nullable: 'YES', column_default: null },
        ];

        const ordersColumns: TableColumn[] = [
          { column_name: 'id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
          { column_name: 'user_id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
        ];

        vi.mocked(mockConnector.getTableSchema).mockImplementation(async (table) => {
          if (table === 'users') return usersColumns;
          if (table === 'orders') return ordersColumns;
          return [];
        });

        const handler = createSearchDatabaseObjectsToolHandler();
        const result = await handler(
          {
            object_type: 'column',
            pattern: '%',
            schema: 'public',
            table: 'users',
            detail_level: 'names',
          },
          null
        );

        const parsed = parseToolResponse(result);
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

      it('should require schema when table is specified', async () => {
        const handler = createSearchDatabaseObjectsToolHandler();
        const result = await handler(
          {
            object_type: 'column',
            pattern: '%',
            table: 'users',
            detail_level: 'names',
          },
          null
        );

        expect(result.isError).toBe(true);
        const parsed = parseToolResponse(result);
        expect(parsed.code).toBe('SCHEMA_REQUIRED');
        expect(parsed.error).toContain("'table' parameter requires 'schema'");
      });

      it('should work with column pattern when table filter is applied', async () => {
        const usersColumns: TableColumn[] = [
          { column_name: 'id', data_type: 'INTEGER', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'TEXT', is_nullable: 'YES', column_default: null },
          { column_name: 'email', data_type: 'TEXT', is_nullable: 'YES', column_default: null },
        ];

        vi.mocked(mockConnector.getTableSchema).mockResolvedValue(usersColumns);

        const handler = createSearchDatabaseObjectsToolHandler();
        const result = await handler(
          {
            object_type: 'column',
            pattern: '%e%',
            schema: 'public',
            table: 'users',
            detail_level: 'names',
          },
          null
        );

        const parsed = parseToolResponse(result);
        expect(parsed.data.count).toBe(2);
        expect(parsed.data.results.map((r: any) => r.name)).toEqual(['name', 'email']);
      });
    });

    describe('for indexes', () => {
      beforeEach(() => {
        vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);
      });

      it('should filter indexes by table when table parameter is provided', async () => {
        const usersIndexes: TableIndex[] = [
          {
            index_name: 'users_pkey',
            column_names: ['id'],
            is_unique: true,
            is_primary: true,
          },
          {
            index_name: 'users_email_idx',
            column_names: ['email'],
            is_unique: true,
            is_primary: false,
          },
        ];

        const ordersIndexes: TableIndex[] = [
          {
            index_name: 'orders_pkey',
            column_names: ['id'],
            is_unique: true,
            is_primary: true,
          },
        ];

        vi.mocked(mockConnector.getTableIndexes).mockImplementation(async (table) => {
          if (table === 'users') return usersIndexes;
          if (table === 'orders') return ordersIndexes;
          return [];
        });

        const handler = createSearchDatabaseObjectsToolHandler();
        const result = await handler(
          {
            object_type: 'index',
            pattern: '%',
            schema: 'public',
            table: 'users',
            detail_level: 'names',
          },
          null
        );

        const parsed = parseToolResponse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.data.count).toBe(2);
        expect(parsed.data.results.map((r: any) => r.name)).toEqual(['users_pkey', 'users_email_idx']);
        // Verify only users table was queried
        expect(mockConnector.getTableIndexes).toHaveBeenCalledWith('users', 'public');
        expect(mockConnector.getTableIndexes).not.toHaveBeenCalledWith('orders', 'public');
      });
    });

    describe('validation', () => {
      it('should reject table parameter for schema object type', async () => {
        vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);

        const handler = createSearchDatabaseObjectsToolHandler();
        const result = await handler(
          {
            object_type: 'schema',
            pattern: '%',
            schema: 'public',
            table: 'users',
            detail_level: 'names',
          },
          null
        );

        expect(result.isError).toBe(true);
        const parsed = parseToolResponse(result);
        expect(parsed.code).toBe('INVALID_TABLE_FILTER');
        expect(parsed.error).toContain("only applies to object_type 'column' or 'index'");
      });

      it('should reject table parameter for table object type', async () => {
        vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);

        const handler = createSearchDatabaseObjectsToolHandler();
        const result = await handler(
          {
            object_type: 'table',
            pattern: '%',
            schema: 'public',
            table: 'users',
            detail_level: 'names',
          },
          null
        );

        expect(result.isError).toBe(true);
        const parsed = parseToolResponse(result);
        expect(parsed.code).toBe('INVALID_TABLE_FILTER');
      });

      it('should reject table parameter for procedure object type', async () => {
        vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);

        const handler = createSearchDatabaseObjectsToolHandler();
        const result = await handler(
          {
            object_type: 'procedure',
            pattern: '%',
            schema: 'public',
            table: 'users',
            detail_level: 'names',
          },
          null
        );

        expect(result.isError).toBe(true);
        const parsed = parseToolResponse(result);
        expect(parsed.code).toBe('INVALID_TABLE_FILTER');
      });
    });
  });

  describe('error handling', () => {
    it('should validate schema exists', async () => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue(['public']);

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'table',
          pattern: '%',
          schema: 'nonexistent',
          detail_level: 'names',
        },
        null
      );

      expect(result.isError).toBe(true);
      const parsed = parseToolResponse(result);
      expect(parsed.code).toBe('SCHEMA_NOT_FOUND');
    });

    it('should handle connector errors gracefully', async () => {
      vi.mocked(mockConnector.getSchemas).mockRejectedValue(new Error('Connection failed'));

      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'schema',
          pattern: '%',
          detail_level: 'names',
        },
        null
      );

      expect(result.isError).toBe(true);
      const parsed = parseToolResponse(result);
      expect(parsed.code).toBe('SEARCH_ERROR');
    });
  });

  describe('case insensitivity', () => {
    beforeEach(() => {
      vi.mocked(mockConnector.getSchemas).mockResolvedValue(['Public', 'Private']);
    });

    it('should perform case-insensitive search', async () => {
      const handler = createSearchDatabaseObjectsToolHandler();
      const result = await handler(
        {
          object_type: 'schema',
          pattern: 'public',
          detail_level: 'names',
        },
        null
      );

      const parsed = parseToolResponse(result);
      expect(parsed.data.results.map((r: any) => r.name)).toEqual(['Public']);
    });
  });

  describe('special character escaping', () => {
    it('should properly escape regex special characters in patterns', async () => {
      // Test that patterns containing regex special characters work correctly
      vi.mocked(mockConnector.getSchemas).mockResolvedValue([
        'table[1]',
        'table(prod)',
        'data.backup',
        'test+logs',
        'user*data',
      ]);

      const handler = createSearchDatabaseObjectsToolHandler();

      // Test bracket characters
      const bracketResult = await handler(
        {
          object_type: 'schema',
          pattern: 'table[1]',
          detail_level: 'names',
        },
        null
      );
      const bracketParsed = parseToolResponse(bracketResult);
      expect(bracketParsed.data.results.map((r: any) => r.name)).toEqual(['table[1]']);

      // Test parentheses
      const parenResult = await handler(
        {
          object_type: 'schema',
          pattern: 'table(prod)',
          detail_level: 'names',
        },
        null
      );
      const parenParsed = parseToolResponse(parenResult);
      expect(parenParsed.data.results.map((r: any) => r.name)).toEqual(['table(prod)']);

      // Test dot character
      const dotResult = await handler(
        {
          object_type: 'schema',
          pattern: 'data.backup',
          detail_level: 'names',
        },
        null
      );
      const dotParsed = parseToolResponse(dotResult);
      expect(dotParsed.data.results.map((r: any) => r.name)).toEqual(['data.backup']);

      // Test plus character
      const plusResult = await handler(
        {
          object_type: 'schema',
          pattern: 'test+logs',
          detail_level: 'names',
        },
        null
      );
      const plusParsed = parseToolResponse(plusResult);
      expect(plusParsed.data.results.map((r: any) => r.name)).toEqual(['test+logs']);

      // Test asterisk character (but not SQL wildcard)
      const asteriskResult = await handler(
        {
          object_type: 'schema',
          pattern: 'user*data',
          detail_level: 'names',
        },
        null
      );
      const asteriskParsed = parseToolResponse(asteriskResult);
      expect(asteriskParsed.data.results.map((r: any) => r.name)).toEqual(['user*data']);
    });
  });
});
