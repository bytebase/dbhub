import { describe, it, expect } from "vitest";
import http from "http";
import {
  configureHttpKeepAlive,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_HEADERS_TIMEOUT_MS,
} from "../http-keep-alive.js";

describe("configureHttpKeepAlive", () => {
  it("raises keep-alive above a 60s proxy idle timeout (issue #472)", () => {
    const server = http.createServer();
    expect(server.keepAliveTimeout).toBe(5_000); // Node default, the bug

    configureHttpKeepAlive(server);

    expect(server.keepAliveTimeout).toBe(HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HTTP_HEADERS_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
    server.close();
  });

  it("keeps headersTimeout strictly above keepAliveTimeout, as Node requires", () => {
    expect(HTTP_HEADERS_TIMEOUT_MS).toBeGreaterThan(HTTP_KEEP_ALIVE_TIMEOUT_MS);
  });
});
