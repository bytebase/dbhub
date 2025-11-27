# Request Tracking Design

Track MCP tool invocations for debugging and observability.

## Requirements

- Store requests in memory (lost on restart)
- Max 100 entries per source, FIFO eviction
- Return requests in reverse chronological order (newest first)
- Track in both HTTP and STDIO modes

## Data Model

```typescript
interface Request {
  id: string;           // UUID
  timestamp: string;    // ISO 8601
  sourceId: string;     // Database source ID
  toolName: string;     // Tool invoked (e.g., "execute_sql_prod_pg")
  sql: string;          // SQL query text
  durationMs: number;   // Execution time in milliseconds
  client: string;       // Client identifier (see below)
  success: boolean;     // Whether execution succeeded
  error?: string;       // Error message if failed
}
```

### Client Identifier Resolution

Cascading fallback:
1. `X-DBHub-Client-Id` header (custom)
2. `User-Agent` header
3. IP address
4. `"stdio"` (for STDIO mode)

## Storage

```typescript
class RequestStore {
  private store = new Map<string, Request[]>();
  private maxPerSource = 100;

  add(request: Request): void {
    const requests = this.store.get(request.sourceId) ?? [];
    requests.push(request);
    if (requests.length > this.maxPerSource) {
      requests.shift();  // FIFO eviction
    }
    this.store.set(request.sourceId, requests);
  }

  getAll(sourceId?: string): Request[] {
    let requests: Request[];
    if (sourceId) {
      requests = this.store.get(sourceId) ?? [];
    } else {
      requests = Array.from(this.store.values()).flat();
    }
    // Newest first
    return requests.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }
}
```

## API

```
GET /api/requests
GET /api/requests?source_id=prod_pg
```

### Response

```json
{
  "requests": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "timestamp": "2025-11-26T10:30:45.123Z",
      "sourceId": "prod_pg",
      "toolName": "execute_sql_prod_pg",
      "sql": "SELECT * FROM users LIMIT 10",
      "durationMs": 45,
      "client": "Claude Desktop/1.0",
      "success": true
    }
  ],
  "total": 1
}
```

## File Structure

### New Files

```
src/requests/
├── store.ts    # RequestStore class
└── index.ts    # Request type, singleton export

src/api/
└── requests.ts # GET /api/requests handler
```

### Modified Files

- `src/server.ts` - Add route: `app.get("/api/requests", listRequests)`
- `src/tools/execute-sql.ts` - Track requests after execution

## Integration

In `src/tools/execute-sql.ts`:

```typescript
export function createExecuteSqlToolHandler(sourceId?: string) {
  return async ({ sql }: { sql: string }, extra: any) => {
    const startTime = Date.now();
    let success = true;
    let errorMessage: string | undefined;

    try {
      // ... existing execution logic ...
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      throw error;
    } finally {
      requestStore.add({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sourceId: sourceId || "default",
        toolName: `execute_sql_${sourceId || "default"}`,
        sql,
        durationMs: Date.now() - startTime,
        client: getClientIdentifier(extra),
        success,
        error: errorMessage,
      });
    }
  };
}
```

## Edge Cases

| Case | Behavior |
|------|----------|
| Server restart | All requests lost |
| No requests | Return `{ "requests": [], "total": 0 }` |
| Invalid source_id | Return empty array |
| Long SQL | Store as-is, frontend truncates |
| STDIO mode | Track requests, no HTTP API to retrieve |

## Not Included (YAGNI)

- Pagination
- Persistence to disk
- Request deletion/clearing
- Rate limiting
- WebSocket live updates
