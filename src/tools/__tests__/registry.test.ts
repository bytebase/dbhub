import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { ConnectorManager } from '../../connectors/manager.js';
import type { TomlConfig } from '../../types/config.js';

vi.mock('../../connectors/manager.js');

const makeConfig = (sourceId: string, tools: any[] = []): TomlConfig => ({
  sources: [{ id: sourceId, type: 'sqlite', dsn: `sqlite:///:memory:` }],
  tools,
});

describe('ToolRegistry', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getCustomToolsForSource', () => {
    it('returns empty array for source with only built-in tools', () => {
      const registry = new ToolRegistry(makeConfig('src_a'));
      expect(registry.getCustomToolsForSource('src_a')).toEqual([]);
    });

    it('filters out execute_sql and search_objects', () => {
      const registry = new ToolRegistry(makeConfig('src_a'));
      const tools = registry.getEnabledToolConfigs('src_a');
      const builtinNames = tools.map((t) => t.name);
      expect(builtinNames).toContain('execute_sql');
      expect(builtinNames).toContain('search_objects');

      // Custom tools filter should exclude both
      expect(registry.getCustomToolsForSource('src_a')).toHaveLength(0);
    });
  });

  describe('list_sources conflict detection', () => {
    beforeEach(() => {
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({
        type: 'sqlite',
      } as any);
    });

    it('rejects custom tool starting with list_sources_', () => {
      const config: TomlConfig = {
        sources: [{ id: 'src_a', type: 'sqlite', dsn: 'sqlite:///:memory:' }],
        tools: [
          {
            name: 'list_sources_extra',
            description: 'Conflicts with meta-tool',
            source: 'src_a',
            statement: 'SELECT 1',
          },
        ],
      };

      expect(() => new ToolRegistry(config)).toThrow(/list_sources/);
    });
  });

  describe('isBuiltinTool includes list_sources', () => {
    it('getBuiltinToolConfig returns undefined for list_sources (not per-source)', () => {
      const registry = new ToolRegistry(makeConfig('src_a'));
      // list_sources is a meta-tool, not stored per-source in the registry
      const result = registry.getBuiltinToolConfig('list_sources', 'src_a');
      expect(result).toBeUndefined();
    });

    it('getEnabledBuiltinToolNames does not include list_sources (it is not per-source)', () => {
      const registry = new ToolRegistry(makeConfig('src_a'));
      const names = registry.getEnabledBuiltinToolNames();
      // list_sources is not a per-source tool so not in enabled builtins
      expect(names).not.toContain('list_sources');
      expect(names).toContain('execute_sql');
      expect(names).toContain('search_objects');
    });
  });
});
