import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { zodToParameters, getExecuteSqlMetadata, getSearchObjectsMetadata } from '../tool-metadata.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { getToolRegistry } from '../../tools/registry.js';

vi.mock('../../connectors/manager.js');
vi.mock('../../tools/registry.js');

describe('zodToParameters', () => {
  it('marks ZodString as required string', () => {
    const schema = { name: z.string().describe('A name') };
    const [param] = zodToParameters(schema);
    expect(param).toEqual({ name: 'name', type: 'string', required: true, description: 'A name' });
  });

  it('marks ZodOptional as not required', () => {
    const schema = { pattern: z.string().optional().describe('Optional pattern') };
    const [param] = zodToParameters(schema);
    expect(param).toEqual({ name: 'pattern', type: 'string', required: false, description: 'Optional pattern' });
  });

  it('marks ZodDefault as not required', () => {
    const schema = { limit: z.number().default(100).describe('Max results') };
    const [param] = zodToParameters(schema);
    expect(param).toEqual({ name: 'limit', type: 'number', required: false, description: 'Max results' });
  });

  it('resolves ZodEnum as string type', () => {
    const schema = { level: z.enum(['names', 'summary', 'full']).describe('Detail level') };
    const [param] = zodToParameters(schema);
    expect(param).toEqual({ name: 'level', type: 'string', required: true, description: 'Detail level' });
  });

  it('preserves description from outermost type before unwrapping', () => {
    const schema = { val: z.string().optional().describe('Outer description') };
    const [param] = zodToParameters(schema);
    expect(param).toEqual({ name: 'val', type: 'string', required: false, description: 'Outer description' });
  });

  it('handles multiple params with mixed types', () => {
    const schema = {
      sql: z.string().describe('SQL query'),
      source_id: z.string().describe('Source ID'),
    };
    const params = zodToParameters(schema);
    expect(params).toEqual([
      { name: 'sql', type: 'string', required: true, description: 'SQL query' },
      { name: 'source_id', type: 'string', required: true, description: 'Source ID' },
    ]);
  });
});

describe('getExecuteSqlMetadata', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('single-source mode (sourceId provided)', () => {
    beforeEach(() => {
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ type: 'postgres' } as any);
      vi.mocked(getToolRegistry).mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({}),
      } as any);
    });

    it('returns execute_sql name and includes sourceId and dbType in description', () => {
      const meta = getExecuteSqlMetadata('my_db');
      expect(meta.name).toBe('execute_sql');
      expect(meta.description).toContain('my_db');
      expect(meta.description).toContain('postgres');
    });

    it('schema does not include source_id param', () => {
      const meta = getExecuteSqlMetadata('my_db');
      expect(meta.schema).not.toHaveProperty('source_id');
      expect(meta.schema).toHaveProperty('sql');
    });

    it('annotations reflect readonly=false by default', () => {
      const meta = getExecuteSqlMetadata('my_db');
      expect(meta.annotations.readOnlyHint).toBe(false);
      expect(meta.annotations.destructiveHint).toBe(true);
    });

    it('annotations reflect readonly=true when configured', () => {
      vi.mocked(getToolRegistry).mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ readonly: true }),
      } as any);
      const meta = getExecuteSqlMetadata('my_db');
      expect(meta.annotations.readOnlyHint).toBe(true);
      expect(meta.annotations.destructiveHint).toBe(false);
      expect(meta.description).toContain('READ-ONLY MODE');
    });

    it('description includes max_rows note when configured', () => {
      vi.mocked(getToolRegistry).mockReturnValue({
        getBuiltinToolConfig: vi.fn().mockReturnValue({ max_rows: 500 }),
      } as any);
      const meta = getExecuteSqlMetadata('my_db');
      expect(meta.description).toContain('500');
    });
  });

  describe('multi-source mode (sourceId undefined)', () => {
    it('returns execute_sql name and description mentions list_sources for discovery', () => {
      const meta = getExecuteSqlMetadata(undefined);
      expect(meta.name).toBe('execute_sql');
      expect(meta.description).toContain('list_sources');
    });

    it('schema includes source_id param', () => {
      const meta = getExecuteSqlMetadata(undefined);
      expect(meta.schema).toHaveProperty('source_id');
      expect(meta.schema).toHaveProperty('sql');
    });

    it('annotations are non-readonly (generic tool can write)', () => {
      const meta = getExecuteSqlMetadata(undefined);
      expect(meta.annotations.readOnlyHint).toBe(false);
      expect(meta.annotations.destructiveHint).toBe(true);
    });

    it('does not call ConnectorManager', () => {
      getExecuteSqlMetadata(undefined);
      expect(ConnectorManager.getSourceConfig).not.toHaveBeenCalled();
    });
  });
});

describe('getSearchObjectsMetadata', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('single-source mode (sourceId provided)', () => {
    beforeEach(() => {
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ type: 'sqlite' } as any);
    });

    it('returns search_objects name and includes sourceId and dbType in description', () => {
      const meta = getSearchObjectsMetadata('local_db');
      expect(meta.name).toBe('search_objects');
      expect(meta.description).toContain('local_db');
      expect(meta.description).toContain('sqlite');
    });

    it('schema does not include source_id param', () => {
      const meta = getSearchObjectsMetadata('local_db');
      expect(meta.schema).not.toHaveProperty('source_id');
    });

    it('annotations are read-only', () => {
      const meta = getSearchObjectsMetadata('local_db');
      expect(meta.annotations.readOnlyHint).toBe(true);
      expect(meta.annotations.destructiveHint).toBe(false);
    });
  });

  describe('multi-source mode (sourceId undefined)', () => {
    it('returns search_objects name and description mentions list_sources for discovery', () => {
      const meta = getSearchObjectsMetadata(undefined);
      expect(meta.name).toBe('search_objects');
      expect(meta.description).toContain('list_sources');
    });

    it('schema includes source_id param', () => {
      const meta = getSearchObjectsMetadata(undefined);
      expect(meta.schema).toHaveProperty('source_id');
    });

    it('annotations are read-only', () => {
      const meta = getSearchObjectsMetadata(undefined);
      expect(meta.annotations.readOnlyHint).toBe(true);
      expect(meta.annotations.destructiveHint).toBe(false);
    });

    it('does not call ConnectorManager', () => {
      getSearchObjectsMetadata(undefined);
      expect(ConnectorManager.getSourceConfig).not.toHaveBeenCalled();
    });
  });
});
