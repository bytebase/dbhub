import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElasticsearchSearchToolHandler } from '../elasticsearch-search-handler.js';
import { ConnectorManager } from '../../connectors/manager.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');

describe('elasticsearch-search tool', () => {
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);
  const mockEnsureConnected = vi.mocked(ConnectorManager.ensureConnected);

  beforeEach(() => {
    mockEnsureConnected.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should execute an Elasticsearch search successfully', async () => {
    const mockResult = {
      hits: {
        total: 100,
        documents: [{ id: 1, title: 'test' }],
      },
      aggregations: {
        status: { buckets: [] },
      },
    };
    const mockConnector = {
      id: 'elasticsearch',
      executeCommand: vi.fn().mockResolvedValue(mockResult),
    };
    mockGetCurrentConnector.mockReturnValue(mockConnector as any);

    const handler = createElasticsearchSearchToolHandler('test_es');
    const result = await handler({ query: '{"query": {"match_all": {}}}' }, null);

    const parsedResult = JSON.parse(result.content[0].text);
    expect(parsedResult.success).toBe(true);
    expect(parsedResult.data.total_hits).toBe(100);
    expect(parsedResult.data.documents).toEqual([{ id: 1, title: 'test' }]);
    expect(mockConnector.executeCommand).toHaveBeenCalledWith('{"query": {"match_all": {}}}');
  });

  it('should return error for non-elasticsearch connector', async () => {
    const mockConnector = {
      id: 'postgres',
    };
    mockGetCurrentConnector.mockReturnValue(mockConnector as any);

    const handler = createElasticsearchSearchToolHandler('test_es');
    const result = await handler({ query: 'some query' }, null);

    const parsedResult = JSON.parse(result.content[0].text);
    expect(parsedResult.success).toBe(false);
    expect(parsedResult.error).toContain('only works with Elasticsearch');
  });

  it('should handle execution errors', async () => {
    const mockConnector = {
      id: 'elasticsearch',
      executeCommand: vi.fn().mockRejectedValue(new Error('ES query failed')),
    };
    mockGetCurrentConnector.mockReturnValue(mockConnector as any);

    const handler = createElasticsearchSearchToolHandler('test_es');
    const result = await handler({ query: 'invalid query' }, null);

    const parsedResult = JSON.parse(result.content[0].text);
    expect(parsedResult.success).toBe(false);
    expect(parsedResult.error).toBe('ES query failed');
  });
});
