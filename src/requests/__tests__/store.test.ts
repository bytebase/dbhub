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

    it("should evict oldest when exceeding max per source, leaving other sources alone", () => {
      store.add(createRequest({ sourceId: "other_db", id: "other" }));
      // Add 101 requests to same source
      for (let i = 0; i < 101; i++) {
        store.add(createRequest({ id: `id-${i}`, sql: `SELECT ${i}` }));
      }
      const requests = store.getAll("test_db");
      expect(requests).toHaveLength(100);
      // First request (id-0) should be evicted
      expect(requests.find((r) => r.id === "id-0")).toBeUndefined();
      // Last request (id-100) should exist
      expect(requests.find((r) => r.id === "id-100")).toBeDefined();
      // The limit is per source: the other source's older request survives
      expect(store.getAll("other_db").map((r) => r.id)).toEqual(["other"]);
      expect(store.getAll()).toHaveLength(101);
    });
  });

  describe("getAll", () => {
    it("should return empty array when no requests", () => {
      expect(store.getAll()).toEqual([]);
    });

    it("should return empty array for unknown sourceId", () => {
      store.add(createRequest({ sourceId: "db1" }));
      expect(store.getAll("unknown")).toEqual([]);
    });

    it("should return requests newest first, for every source or only the one asked for", () => {
      const now = Date.now();
      const at = (ageMs: number) => new Date(now - ageMs).toISOString();
      store.add(createRequest({ sourceId: "db1", id: "old", timestamp: at(1000) }));
      store.add(createRequest({ sourceId: "db2", id: "new", timestamp: at(0) }));
      store.add(createRequest({ sourceId: "db1", id: "older", timestamp: at(2000) }));
      store.add(createRequest({ sourceId: "db1", id: "newish", timestamp: at(500) }));

      expect(store.getAll().map((r) => r.id)).toEqual(["new", "newish", "old", "older"]);
      expect(store.getAll("db1").map((r) => r.id)).toEqual(["newish", "old", "older"]);
    });
  });

  describe("clear", () => {
    it("should remove all requests", () => {
      store.add(createRequest());
      store.add(createRequest());
      store.clear();
      expect(store.getAll()).toEqual([]);
    });
  });
});
