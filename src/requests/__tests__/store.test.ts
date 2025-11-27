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
