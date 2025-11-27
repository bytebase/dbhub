import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import express, { Application } from "express";
import { Server } from "http";
import { requestStore, Request } from "../../requests/index.js";
import { listRequests } from "../requests.js";

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

describe("GET /api/requests - Integration Tests", () => {
  let app: Application;
  let server: Server;
  const TEST_PORT = 13580; // Use a unique port to avoid conflicts
  const BASE_URL = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    // Set up Express app with API routes
    app = express();
    app.use(express.json());
    app.get("/api/requests", listRequests);

    // Start server
    await new Promise<void>((resolve) => {
      server = app.listen(TEST_PORT, () => {
        resolve();
      });
    });
  }, 30000);

  afterAll(async () => {
    // Cleanup
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  beforeEach(() => {
    // Clear the request store before each test to ensure isolation
    requestStore.clear();
  });

  describe("Empty State", () => {
    it("should return empty array when no requests tracked", async () => {
      const response = await fetch(`${BASE_URL}/api/requests`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");

      const data = await response.json();
      expect(data.requests).toEqual([]);
      expect(data.total).toBe(0);
    });

    it("should return empty array for unknown source_id", async () => {
      requestStore.add(createRequest({ sourceId: "db1" }));

      const response = await fetch(`${BASE_URL}/api/requests?source_id=nonexistent`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.requests).toEqual([]);
      expect(data.total).toBe(0);
    });
  });

  describe("All Requests", () => {
    it("should return all requests across sources", async () => {
      requestStore.add(createRequest({ sourceId: "db1", id: "req1" }));
      requestStore.add(createRequest({ sourceId: "db2", id: "req2" }));
      requestStore.add(createRequest({ sourceId: "db1", id: "req3" }));

      const response = await fetch(`${BASE_URL}/api/requests`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.requests).toHaveLength(3);
      expect(data.total).toBe(3);
    });

    it("should return correct request structure", async () => {
      const testRequest = createRequest({
        id: "test-id",
        sourceId: "prod_db",
        toolName: "execute_sql_prod_db",
        sql: "SELECT * FROM users",
        durationMs: 150,
        client: "claude-desktop",
        success: true,
      });
      requestStore.add(testRequest);

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests).toHaveLength(1);
      const returned = data.requests[0];
      expect(returned.id).toBe("test-id");
      expect(returned.sourceId).toBe("prod_db");
      expect(returned.toolName).toBe("execute_sql_prod_db");
      expect(returned.sql).toBe("SELECT * FROM users");
      expect(returned.durationMs).toBe(150);
      expect(returned.client).toBe("claude-desktop");
      expect(returned.success).toBe(true);
      expect(returned.timestamp).toBeDefined();
    });
  });

  describe("Filtering by source_id", () => {
    beforeEach(() => {
      // Add requests to multiple sources
      requestStore.add(createRequest({ sourceId: "db1", id: "db1-req1", sql: "SELECT 1" }));
      requestStore.add(createRequest({ sourceId: "db2", id: "db2-req1", sql: "SELECT 2" }));
      requestStore.add(createRequest({ sourceId: "db1", id: "db1-req2", sql: "SELECT 3" }));
      requestStore.add(createRequest({ sourceId: "db3", id: "db3-req1", sql: "SELECT 4" }));
      requestStore.add(createRequest({ sourceId: "db1", id: "db1-req3", sql: "SELECT 5" }));
    });

    it("should filter requests by source_id parameter", async () => {
      const response = await fetch(`${BASE_URL}/api/requests?source_id=db1`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.requests).toHaveLength(3);
      expect(data.total).toBe(3);
      expect(data.requests.every((r: Request) => r.sourceId === "db1")).toBe(true);
    });

    it("should return only requests for specified source", async () => {
      const response = await fetch(`${BASE_URL}/api/requests?source_id=db2`);
      const data = await response.json();

      expect(data.requests).toHaveLength(1);
      expect(data.requests[0].id).toBe("db2-req1");
      expect(data.requests[0].sourceId).toBe("db2");
    });

    it("should handle URL-encoded source_id", async () => {
      requestStore.clear();
      requestStore.add(createRequest({ sourceId: "db_with_underscore", id: "test" }));

      const response = await fetch(
        `${BASE_URL}/api/requests?source_id=${encodeURIComponent("db_with_underscore")}`
      );
      const data = await response.json();

      expect(data.requests).toHaveLength(1);
      expect(data.requests[0].sourceId).toBe("db_with_underscore");
    });

    it("should return all requests when source_id not provided", async () => {
      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests).toHaveLength(5);
      expect(data.total).toBe(5);
    });
  });

  describe("Reverse Chronological Order", () => {
    it("should return requests in reverse chronological order (newest first)", async () => {
      const now = Date.now();
      requestStore.add(
        createRequest({ id: "old", timestamp: new Date(now - 3000).toISOString() })
      );
      requestStore.add(
        createRequest({ id: "newest", timestamp: new Date(now).toISOString() })
      );
      requestStore.add(
        createRequest({ id: "middle", timestamp: new Date(now - 1000).toISOString() })
      );
      requestStore.add(
        createRequest({ id: "older", timestamp: new Date(now - 2000).toISOString() })
      );

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests).toHaveLength(4);
      expect(data.requests[0].id).toBe("newest");
      expect(data.requests[1].id).toBe("middle");
      expect(data.requests[2].id).toBe("older");
      expect(data.requests[3].id).toBe("old");
    });

    it("should maintain reverse chronological order when filtering by source_id", async () => {
      const now = Date.now();
      requestStore.add(
        createRequest({
          sourceId: "db1",
          id: "db1-old",
          timestamp: new Date(now - 2000).toISOString(),
        })
      );
      requestStore.add(
        createRequest({
          sourceId: "db2",
          id: "db2-req",
          timestamp: new Date(now - 1500).toISOString(),
        })
      );
      requestStore.add(
        createRequest({
          sourceId: "db1",
          id: "db1-new",
          timestamp: new Date(now).toISOString(),
        })
      );

      const response = await fetch(`${BASE_URL}/api/requests?source_id=db1`);
      const data = await response.json();

      expect(data.requests).toHaveLength(2);
      expect(data.requests[0].id).toBe("db1-new");
      expect(data.requests[1].id).toBe("db1-old");
    });

    it("should handle requests with identical timestamps", async () => {
      const sameTime = new Date().toISOString();
      requestStore.add(createRequest({ id: "req1", timestamp: sameTime }));
      requestStore.add(createRequest({ id: "req2", timestamp: sameTime }));
      requestStore.add(createRequest({ id: "req3", timestamp: sameTime }));

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      // Should return all 3 requests
      expect(data.requests).toHaveLength(3);
      // Order is stable but not guaranteed for identical timestamps
      const ids = data.requests.map((r: Request) => r.id);
      expect(ids).toContain("req1");
      expect(ids).toContain("req2");
      expect(ids).toContain("req3");
    });
  });

  describe("Error Field", () => {
    it("should include error field for failed requests", async () => {
      requestStore.add(
        createRequest({
          id: "failed-req",
          success: false,
          error: "Table 'users' not found",
        })
      );

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests).toHaveLength(1);
      expect(data.requests[0].success).toBe(false);
      expect(data.requests[0].error).toBe("Table 'users' not found");
    });

    it("should not include error field for successful requests", async () => {
      requestStore.add(
        createRequest({
          id: "success-req",
          success: true,
        })
      );

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests).toHaveLength(1);
      expect(data.requests[0].success).toBe(true);
      expect(data.requests[0].error).toBeUndefined();
    });

    it("should handle mix of successful and failed requests", async () => {
      requestStore.add(
        createRequest({
          id: "req1",
          success: true,
          sql: "SELECT 1",
        })
      );
      requestStore.add(
        createRequest({
          id: "req2",
          success: false,
          error: "Syntax error",
          sql: "SLECT 1",
        })
      );
      requestStore.add(
        createRequest({
          id: "req3",
          success: true,
          sql: "SELECT 2",
        })
      );
      requestStore.add(
        createRequest({
          id: "req4",
          success: false,
          error: "Permission denied",
          sql: "DROP TABLE users",
        })
      );

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests).toHaveLength(4);

      const successfulReqs = data.requests.filter((r: Request) => r.success);
      const failedReqs = data.requests.filter((r: Request) => !r.success);

      expect(successfulReqs).toHaveLength(2);
      expect(failedReqs).toHaveLength(2);

      // Verify successful requests don't have error field
      successfulReqs.forEach((r: Request) => {
        expect(r.error).toBeUndefined();
      });

      // Verify failed requests have error field
      failedReqs.forEach((r: Request) => {
        expect(r.error).toBeDefined();
        expect(typeof r.error).toBe("string");
      });
    });

    it("should preserve error messages exactly as provided", async () => {
      const errorMessages = [
        "Syntax error near 'FROM'",
        'Column "invalid_column" does not exist',
        "Connection timeout after 30 seconds",
        "Read-only mode enabled",
      ];

      errorMessages.forEach((errorMsg, idx) => {
        requestStore.add(
          createRequest({
            id: `req-${idx}`,
            success: false,
            error: errorMsg,
          })
        );
      });

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests).toHaveLength(4);
      const returnedErrors = data.requests.map((r: Request) => r.error);

      errorMessages.forEach((errorMsg) => {
        expect(returnedErrors).toContain(errorMsg);
      });
    });
  });

  describe("Response Format", () => {
    it("should return consistent response structure", async () => {
      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data).toHaveProperty("requests");
      expect(data).toHaveProperty("total");
      expect(Array.isArray(data.requests)).toBe(true);
      expect(typeof data.total).toBe("number");
    });

    it("should have total matching requests array length", async () => {
      requestStore.add(createRequest({ sourceId: "db1" }));
      requestStore.add(createRequest({ sourceId: "db2" }));
      requestStore.add(createRequest({ sourceId: "db1" }));

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.total).toBe(data.requests.length);
      expect(data.total).toBe(3);
    });

    it("should return correct content-type header", async () => {
      const response = await fetch(`${BASE_URL}/api/requests`);
      expect(response.headers.get("content-type")).toContain("application/json");
    });
  });

  describe("Edge Cases", () => {
    it("should handle large number of requests", async () => {
      // Add 150 requests across 3 sources (50 each, but store caps at 100 per source)
      for (let i = 0; i < 50; i++) {
        requestStore.add(createRequest({ sourceId: "db1", id: `db1-${i}` }));
        requestStore.add(createRequest({ sourceId: "db2", id: `db2-${i}` }));
        requestStore.add(createRequest({ sourceId: "db3", id: `db3-${i}` }));
      }

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests).toHaveLength(150);
      expect(data.total).toBe(150);
    });

    it("should handle requests with special characters in SQL", async () => {
      requestStore.add(
        createRequest({
          sql: "SELECT * FROM users WHERE name = 'O''Brien' AND role = \"admin\"",
        })
      );

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests[0].sql).toBe(
        "SELECT * FROM users WHERE name = 'O''Brien' AND role = \"admin\""
      );
    });

    it("should handle requests with very long SQL queries", async () => {
      const longSql = "SELECT " + "a, ".repeat(1000) + "z FROM table";
      requestStore.add(createRequest({ sql: longSql }));

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests[0].sql).toBe(longSql);
    });

    it("should handle various client identifiers", async () => {
      const clients = ["stdio", "claude-desktop", "192.168.1.100", "custom-client-v1.2.3"];

      clients.forEach((client, idx) => {
        requestStore.add(createRequest({ id: `req-${idx}`, client }));
      });

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests).toHaveLength(4);
      const returnedClients = data.requests.map((r: Request) => r.client);

      clients.forEach((client) => {
        expect(returnedClients).toContain(client);
      });
    });

    it("should handle zero duration requests", async () => {
      requestStore.add(createRequest({ durationMs: 0 }));

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests[0].durationMs).toBe(0);
    });

    it("should handle very high duration requests", async () => {
      requestStore.add(createRequest({ durationMs: 999999 }));

      const response = await fetch(`${BASE_URL}/api/requests`);
      const data = await response.json();

      expect(data.requests[0].durationMs).toBe(999999);
    });
  });
});
