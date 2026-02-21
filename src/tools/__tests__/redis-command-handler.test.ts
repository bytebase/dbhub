import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRedisCommandToolHandler } from '../redis-command-handler.js';
import { ConnectorManager } from '../../connectors/manager.js';

// Mock dependencies
vi.mock('../../connectors/manager.js');

describe('redis-command tool', () => {
  const mockGetCurrentConnector = vi.mocked(ConnectorManager.getCurrentConnector);
  const mockEnsureConnected = vi.mocked(ConnectorManager.ensureConnected);

  beforeEach(() => {
    mockEnsureConnected.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should execute a Redis command successfully', async () => {
    const mockConnector = {
      id: 'redis',
      executeCommand: vi.fn().mockResolvedValue({ value: 'bar', type: 'string' }),
    };
    mockGetCurrentConnector.mockReturnValue(mockConnector as any);

    const handler = createRedisCommandToolHandler('test_redis');
    const result = await handler({ command: 'GET foo' }, null);

    const parsedResult = JSON.parse(result.content[0].text);
    expect(parsedResult.success).toBe(true);
    expect(parsedResult.data.value).toBe('bar');
    expect(parsedResult.data.type).toBe('string');
    expect(mockConnector.executeCommand).toHaveBeenCalledWith('GET foo');
  });

  it('should return error for non-redis connector', async () => {
    const mockConnector = {
      id: 'sqlite',
    };
    mockGetCurrentConnector.mockReturnValue(mockConnector as any);

    const handler = createRedisCommandToolHandler('test_redis');
    const result = await handler({ command: 'GET foo' }, null);

    const parsedResult = JSON.parse(result.content[0].text);
    expect(parsedResult.success).toBe(false);
    expect(parsedResult.error).toContain('only works with Redis');
  });

  it('should handle execution errors', async () => {
    const mockConnector = {
      id: 'redis',
      executeCommand: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
    };
    mockGetCurrentConnector.mockReturnValue(mockConnector as any);

    const handler = createRedisCommandToolHandler('test_redis');
    const result = await handler({ command: 'GET foo' }, null);

    const parsedResult = JSON.parse(result.content[0].text);
    expect(parsedResult.success).toBe(false);
    expect(parsedResult.error).toBe('Redis connection lost');
  });
});
