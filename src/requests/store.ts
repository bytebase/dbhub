/**
 * Represents a tracked MCP tool request
 */
export interface Request {
  id: string;
  timestamp: string;
  sourceId: string;
  toolName: string;
  sql: string;
  durationMs: number;
  client: string;
  success: boolean;
  error?: string;
}

/**
 * In-memory store for tracking requests per source
 * Uses FIFO eviction when max entries reached
 */
export class RequestStore {
  private store = new Map<string, Request[]>();
  private maxPerSource = 100;

  /**
   * Add a request to the store
   * Evicts oldest entry if at capacity
   */
  add(request: Request): void {
    const requests = this.store.get(request.sourceId) ?? [];
    requests.push(request);
    if (requests.length > this.maxPerSource) {
      requests.shift();
    }
    this.store.set(request.sourceId, requests);
  }

  /**
   * Get requests, optionally filtered by source
   * Returns newest first
   */
  getAll(sourceId?: string): Request[] {
    let requests: Request[];
    if (sourceId) {
      requests = [...(this.store.get(sourceId) ?? [])];
    } else {
      requests = Array.from(this.store.values()).flat();
    }
    return requests.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /**
   * Get total count of requests across all sources
   */
  getTotal(): number {
    return Array.from(this.store.values()).reduce((sum, arr) => sum + arr.length, 0);
  }

  /**
   * Clear all requests (useful for testing)
   */
  clear(): void {
    this.store.clear();
  }
}
