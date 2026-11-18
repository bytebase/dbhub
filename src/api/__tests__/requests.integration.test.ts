import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { requestStore, Request } from "../../requests/index.js";
import { listRequests } from "../requests.js";
import { startApiServer } from "./test-server.js";

// The endpoint is a thin wrapper over RequestStore (whose ordering, filtering
// and eviction rules are covered in src/requests/__tests__/store.test.ts).
// These tests cover the HTTP contract: the source_id query parameter and the
// { requests, total } envelope, with each request serialized as stored.

const now = Date.now();

function createRequest(overrides: Partial<Request> = {}, ageMs: number = 0): Request {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(now - ageMs).toISOString(),
    sourceId: "test_db",
    toolName: "execute_sql_test_db",
    sql: "SELECT 1",
    durationMs: 10,
    client: "test-client",
    success: true,
    ...overrides,
  };
}

describe("GET /api/requests - Integration Tests", () => {
  let server: Awaited<ReturnType<typeof startApiServer>>;

  const getRequests = async (query: string = "") => {
    const response = await fetch(`${server.baseUrl}/api/requests${query}`);
    return { response, data: (await response.json()) as { requests: Request[]; total: number } };
  };

  beforeAll(async () => {
    server = await startApiServer({ "/api/requests": listRequests });
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  beforeEach(() => {
    // Clear the request store before each test to ensure isolation
    requestStore.clear();
  });

  it("should return empty array when no requests tracked", async () => {
    const { response, data } = await getRequests();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(data).toEqual({ requests: [], total: 0 });
  });

  describe("with requests tracked for several sources", () => {
    beforeEach(() => {
      requestStore.add(createRequest({ sourceId: "db1", id: "db1-old" }, 3000));
      requestStore.add(createRequest({ sourceId: "db2", id: "db2-req" }, 2000));
      requestStore.add(createRequest({ sourceId: "db1", id: "db1-new" }, 0));
      requestStore.add(createRequest({ sourceId: "db3", id: "db3-req" }, 1000));
    });

    it("should return all requests across sources, newest first", async () => {
      const { response, data } = await getRequests();

      expect(response.status).toBe(200);
      expect(data.requests.map((r) => r.id)).toEqual(["db1-new", "db3-req", "db2-req", "db1-old"]);
      expect(data.total).toBe(4);
    });

    it("should filter requests by source_id parameter, newest first", async () => {
      const { response, data } = await getRequests("?source_id=db1");

      expect(response.status).toBe(200);
      expect(data.requests.map((r) => r.id)).toEqual(["db1-new", "db1-old"]);
      expect(data.requests.every((r) => r.sourceId === "db1")).toBe(true);
      expect(data.total).toBe(2);
    });

    it("should return empty array for unknown source_id", async () => {
      const { response, data } = await getRequests("?source_id=nonexistent");

      expect(response.status).toBe(200);
      expect(data).toEqual({ requests: [], total: 0 });
    });
  });

  it("should return every field of a request as stored", async () => {
    const succeeded = createRequest({
      id: "test-id",
      sourceId: "prod_db",
      toolName: "execute_sql_prod_db",
      sql: "SELECT * FROM users WHERE name = 'O''Brien' AND role = \"admin\"",
      durationMs: 999999,
      client: "claude-desktop",
    });
    // Falsy values (a zero duration), a very long query and the error text
    // must come back verbatim
    const failed = createRequest(
      {
        id: "failed-req",
        sql: "SELECT " + "a, ".repeat(1000) + "z FROM table",
        durationMs: 0,
        success: false,
        error: 'Column "invalid_column" does not exist',
      },
      1000
    );
    requestStore.add(succeeded);
    requestStore.add(failed);

    const { data } = await getRequests();

    expect(data.requests).toEqual([succeeded, failed]);
    // No error field for a successful request
    expect(data.requests[0]).not.toHaveProperty("error");
  });
});
