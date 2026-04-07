import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerListSourcesTool } from '../list-sources.js';
import { ConnectorManager } from '../../connectors/manager.js';

vi.mock('../../connectors/manager.js');

const parseToolResponse = (result: any) => JSON.parse(result.content[0].text);

describe('list_sources tool', () => {
  const mockServer = { registerTool: vi.fn() };

  beforeEach(() => {
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(['db_a', 'db_b']);
    vi.mocked(ConnectorManager.getSourceConfig).mockImplementation(
      (id) => ({ id, type: id === 'db_a' ? 'postgres' : 'mysql' }) as any
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers with correct name and annotations', () => {
    registerListSourcesTool(mockServer as any);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'list_sources',
      expect.objectContaining({
        description: expect.stringContaining('source_id'),
        inputSchema: {},
        annotations: expect.objectContaining({
          title: 'List Database Sources',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        }),
      }),
      expect.any(Function)
    );
  });

  it('handler returns all sources with id and type', async () => {
    registerListSourcesTool(mockServer as any);
    const handler = mockServer.registerTool.mock.calls[0][2];

    const result = await handler();
    const parsed = parseToolResponse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.data.sources).toEqual([
      { id: 'db_a', type: 'postgres' },
      { id: 'db_b', type: 'mysql' },
    ]);
  });

  it('handler returns empty array when no sources', async () => {
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue([]);

    registerListSourcesTool(mockServer as any);
    const handler = mockServer.registerTool.mock.calls[0][2];

    const result = await handler();
    const parsed = parseToolResponse(result);

    expect(parsed.data.sources).toEqual([]);
  });

  it('handler includes type from source config', async () => {
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(['sqlite_src']);
    vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({ type: 'sqlite' } as any);

    registerListSourcesTool(mockServer as any);
    const handler = mockServer.registerTool.mock.calls[0][2];

    const result = await handler();
    const parsed = parseToolResponse(result);

    expect(parsed.data.sources[0]).toEqual({ id: 'sqlite_src', type: 'sqlite' });
  });
});
