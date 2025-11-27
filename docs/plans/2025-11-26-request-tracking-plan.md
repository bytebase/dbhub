# Request Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track MCP tool invocations in memory for debugging and observability.

**Architecture:** In-memory store with Map<sourceId, Request[]>, FIFO eviction at 100 entries per source. Single API endpoint with optional source_id filter. Hook into execute-sql tool handler.

**Tech Stack:** TypeScript, Express, Node crypto.randomUUID()

---

## Task 1: Create Request Type and Store

**Files:**
- Create: `src/requests/store.ts`
- Create: `src/requests/index.ts`

**Step 1: Create the Request interface and RequestStore class**

Create `src/requests/store.ts`:

```typescript
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
```

**Step 2: Create the singleton export**

Create `src/requests/index.ts`:

```typescript
export { Request, RequestStore } from "./store.js";
import { RequestStore } from "./store.js";

/**
 * Singleton request store instance
 */
export const requestStore = new RequestStore();
```

**Step 3: Verify TypeScript compiles**

Run: `pnpm run build`
Expected: Build succeeds with no errors

**Step 4: Commit**

```bash
git add src/requests/
git commit -m "feat(requests): add Request type and RequestStore class"
```

---

## Task 2: Add Unit Tests for RequestStore

**Files:**
- Create: `src/requests/__tests__/store.test.ts`

**Step 1: Write tests for RequestStore**

Create `src/requests/__tests__/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { RequestStore, Request } from "../store.js";

function createRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sourceId: "test_db",
    toolName: "execute_sql_test_db",
    sql: "SELECT 1",
    durationMs: 10,
    client: "test-client",
    success: true,
    ...overrides,
  };
}

describe("RequestStore", () => {
  let store: RequestStore;

  beforeEach(() => {
    store = new RequestStore();
  });

  describe("add", () => {
    it("should add a request", () => {
      const request = createRequest();
      store.add(request);
      const requests = store.getAll();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual(request);
    });

    it("should evict oldest when exceeding max per source", () => {
      // Add 101 requests to same source
      for (let i = 0; i < 101; i++) {
        store.add(createRequest({ id: `id-${i}`, sql: `SELECT ${i}` }));
      }
      const requests = store.getAll();
      expect(requests).toHaveLength(100);
      // First request (id-0) should be evicted
      expect(requests.find((r) => r.id === "id-0")).toBeUndefined();
      // Last request (id-100) should exist
      expect(requests.find((r) => r.id === "id-100")).toBeDefined();
    });

    it("should track separate limits per source", () => {
      // Add 50 to source A, 50 to source B
      for (let i = 0; i < 50; i++) {
        store.add(createRequest({ sourceId: "source_a", id: `a-${i}` }));
        store.add(createRequest({ sourceId: "source_b", id: `b-${i}` }));
      }
      expect(store.getAll()).toHaveLength(100);
      expect(store.getAll("source_a")).toHaveLength(50);
      expect(store.getAll("source_b")).toHaveLength(50);
    });
  });

  describe("getAll", () => {
    it("should return empty array when no requests", () => {
      expect(store.getAll()).toEqual([]);
    });

    it("should filter by sourceId", () => {
      store.add(createRequest({ sourceId: "db1", id: "1" }));
      store.add(createRequest({ sourceId: "db2", id: "2" }));
      store.add(createRequest({ sourceId: "db1", id: "3" }));

      const db1Requests = store.getAll("db1");
      expect(db1Requests).toHaveLength(2);
      expect(db1Requests.every((r) => r.sourceId === "db1")).toBe(true);
    });

    it("should return empty array for unknown sourceId", () => {
      store.add(createRequest({ sourceId: "db1" }));
      expect(store.getAll("unknown")).toEqual([]);
    });

    it("should return requests in reverse chronological order", () => {
      const now = Date.now();
      store.add(createRequest({ id: "old", timestamp: new Date(now - 1000).toISOString() }));
      store.add(createRequest({ id: "new", timestamp: new Date(now).toISOString() }));
      store.add(createRequest({ id: "older", timestamp: new Date(now - 2000).toISOString() }));

      const requests = store.getAll();
      expect(requests[0].id).toBe("new");
      expect(requests[1].id).toBe("old");
      expect(requests[2].id).toBe("older");
    });
  });

  describe("getTotal", () => {
    it("should return 0 when empty", () => {
      expect(store.getTotal()).toBe(0);
    });

    it("should return total across all sources", () => {
      store.add(createRequest({ sourceId: "db1" }));
      store.add(createRequest({ sourceId: "db2" }));
      store.add(createRequest({ sourceId: "db1" }));
      expect(store.getTotal()).toBe(3);
    });
  });

  describe("clear", () => {
    it("should remove all requests", () => {
      store.add(createRequest());
      store.add(createRequest());
      store.clear();
      expect(store.getAll()).toEqual([]);
      expect(store.getTotal()).toBe(0);
    });
  });
});
```

**Step 2: Run tests**

Run: `pnpm test src/requests/__tests__/store.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/requests/__tests__/
git commit -m "test(requests): add unit tests for RequestStore"
```

---

## Task 3: Create API Handler

**Files:**
- Create: `src/api/requests.ts`

**Step 1: Create the requests API handler**

Create `src/api/requests.ts`:

```typescript
import { Request as ExpressRequest, Response } from "express";
import { requestStore } from "../requests/index.js";

/**
 * GET /api/requests
 * GET /api/requests?source_id=prod_pg
 * List tracked requests, optionally filtered by source
 */
export function listRequests(req: ExpressRequest, res: Response): void {
  try {
    const sourceId = req.query.source_id as string | undefined;
    const requests = requestStore.getAll(sourceId);

    res.json({
      requests,
      total: requests.length,
    });
  } catch (error) {
    console.error("Error listing requests:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `pnpm run build`
Expected: Build succeeds with no errors

**Step 3: Commit**

```bash
git add src/api/requests.ts
git commit -m "feat(api): add GET /api/requests handler"
```

---

## Task 4: Register API Route

**Files:**
- Modify: `src/server.ts`

**Step 1: Import listRequests handler**

In `src/server.ts`, add import after line 16 (`import { listSources, getSource } from "./api/sources.js";`):

```typescript
import { listRequests } from "./api/requests.js";
```

**Step 2: Add route registration**

In `src/server.ts`, add route after line 196 (`app.get("/api/sources/:sourceId", getSource);`):

```typescript
app.get("/api/requests", listRequests);
```

**Step 3: Verify TypeScript compiles**

Run: `pnpm run build`
Expected: Build succeeds with no errors

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): register GET /api/requests route"
```

---

## Task 5: Integrate Request Tracking into Tool Handler

**Files:**
- Modify: `src/tools/execute-sql.ts`

**Step 1: Add imports**

In `src/tools/execute-sql.ts`, add after line 6 (`import { ConnectorType } from "../connectors/interface.js";`):

```typescript
import { requestStore } from "../requests/index.js";
```

**Step 2: Add client identifier helper function**

In `src/tools/execute-sql.ts`, add after the imports (around line 8):

```typescript
/**
 * Extract client identifier from request context
 * Priority: X-DBHub-Client-Id header > User-Agent > IP > "stdio"
 */
function getClientIdentifier(extra: any): string {
  // Try to get headers from the extra context
  // MCP SDK passes request info in extra.requestContext or similar
  const headers = extra?.requestContext?.headers || extra?.headers || {};

  // Priority 1: Custom header
  const customHeader = headers["x-dbhub-client-id"] || headers["X-DBHub-Client-Id"];
  if (customHeader) {
    return customHeader;
  }

  // Priority 2: User-Agent
  const userAgent = headers["user-agent"] || headers["User-Agent"];
  if (userAgent) {
    return userAgent;
  }

  // Priority 3: IP address
  const ip = extra?.requestContext?.ip || extra?.ip;
  if (ip) {
    return ip;
  }

  // Default for STDIO mode
  return "stdio";
}
```

**Step 3: Refactor createExecuteSqlToolHandler to track requests**

Replace the `createExecuteSqlToolHandler` function (lines 82-112) with:

```typescript
/**
 * Create an execute_sql tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to (undefined for single-source mode)
 * @returns A handler function bound to the specified source
 */
export function createExecuteSqlToolHandler(sourceId?: string) {
  return async ({ sql }: { sql: string }, extra: any) => {
    const startTime = Date.now();
    const effectiveSourceId = sourceId || "default";
    let success = true;
    let errorMessage: string | undefined;
    let result: any;

    try {
      // Get connector and execute options for the specified source (or default)
      const connector = ConnectorManager.getCurrentConnector(sourceId);
      const executeOptions = ConnectorManager.getCurrentExecuteOptions(sourceId);

      // Check if SQL is allowed based on readonly mode
      if (isReadOnlyMode() && !areAllStatementsReadOnly(sql, connector.id)) {
        errorMessage = `Read-only mode is enabled. Only the following SQL operations are allowed: ${allowedKeywords[connector.id]?.join(", ") || "none"}`;
        success = false;
        return createToolErrorResponse(errorMessage, "READONLY_VIOLATION");
      }

      // Execute the SQL (single or multiple statements) if validation passed
      result = await connector.executeSQL(sql, executeOptions);

      // Build response data
      const responseData = {
        rows: result.rows,
        count: result.rows.length,
        source_id: effectiveSourceId,
      };

      return createToolSuccessResponse(responseData);
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      // Track the request
      requestStore.add({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sourceId: effectiveSourceId,
        toolName: `execute_sql_${effectiveSourceId}`,
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

**Step 4: Verify TypeScript compiles**

Run: `pnpm run build`
Expected: Build succeeds with no errors

**Step 5: Commit**

```bash
git add src/tools/execute-sql.ts
git commit -m "feat(tools): integrate request tracking into execute_sql handler"
```

---

## Task 6: Add Integration Test

**Files:**
- Create: `src/api/__tests__/requests.integration.test.ts`

**Step 1: Write integration test**

Create `src/api/__tests__/requests.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { requestStore, Request } from "../../requests/index.js";

function createRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sourceId: "test_db",
    toolName: "execute_sql_test_db",
    sql: "SELECT 1",
    durationMs: 10,
    client: "test-client",
    success: true,
    ...overrides,
  };
}

describe("GET /api/requests", () => {
  beforeEach(() => {
    requestStore.clear();
  });

  it("should return empty array when no requests", () => {
    const requests = requestStore.getAll();
    expect(requests).toEqual([]);
  });

  it("should return all requests across sources", () => {
    requestStore.add(createRequest({ sourceId: "db1" }));
    requestStore.add(createRequest({ sourceId: "db2" }));

    const requests = requestStore.getAll();
    expect(requests).toHaveLength(2);
  });

  it("should filter by source_id", () => {
    requestStore.add(createRequest({ sourceId: "db1", id: "1" }));
    requestStore.add(createRequest({ sourceId: "db2", id: "2" }));
    requestStore.add(createRequest({ sourceId: "db1", id: "3" }));

    const requests = requestStore.getAll("db1");
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.sourceId === "db1")).toBe(true);
  });

  it("should return requests in reverse chronological order", () => {
    const now = Date.now();
    requestStore.add(createRequest({ id: "old", timestamp: new Date(now - 1000).toISOString() }));
    requestStore.add(createRequest({ id: "new", timestamp: new Date(now).toISOString() }));

    const requests = requestStore.getAll();
    expect(requests[0].id).toBe("new");
    expect(requests[1].id).toBe("old");
  });

  it("should include error field for failed requests", () => {
    requestStore.add(createRequest({ success: false, error: "Table not found" }));

    const requests = requestStore.getAll();
    expect(requests[0].success).toBe(false);
    expect(requests[0].error).toBe("Table not found");
  });
});
```

**Step 2: Run tests**

Run: `pnpm test src/api/__tests__/requests.integration.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/api/__tests__/requests.integration.test.ts
git commit -m "test(api): add integration tests for requests endpoint"
```

---

## Task 7: Manual End-to-End Verification

**Step 1: Start server in demo mode**

Run: `pnpm run dev -- --demo --transport=http --port=8080`
Expected: Server starts successfully

**Step 2: Make MCP request to execute SQL**

In a new terminal, run:
```bash
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "X-DBHub-Client-Id: test-client" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_sql_demo","arguments":{"sql":"SELECT * FROM employees LIMIT 5"}}}'
```
Expected: JSON response with employee data

**Step 3: Verify request was tracked**

Run:
```bash
curl http://localhost:8080/api/requests | jq
```
Expected: Response includes the request just made with correct fields

**Step 4: Stop server**

Press Ctrl+C to stop the server

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Request type and store | `src/requests/store.ts`, `src/requests/index.ts` |
| 2 | Unit tests | `src/requests/__tests__/store.test.ts` |
| 3 | API handler | `src/api/requests.ts` |
| 4 | Route registration | `src/server.ts` |
| 5 | Tool integration | `src/tools/execute-sql.ts` |
| 6 | Integration tests | `src/api/__tests__/requests.integration.test.ts` |
| 7 | Manual E2E test | N/A |
