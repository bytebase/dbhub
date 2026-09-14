import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

/**
 * Pools must carry an 'error' listener (bytebase/dbhub#422).
 *
 * pg-pool re-emits an idle client's error (server restart, failover,
 * idle-timeout close) as an 'error' event on the pool, and the mariadb pool
 * emits 'error' when a background reconnect attempt fails. An EventEmitter
 * with no 'error' listener throws on emit, which Node reports as an
 * unhandled 'error' event and exits the process. Over stdio, MCP clients do
 * not restart the server, so the crash takes the database tools away until
 * the user reconnects manually.
 *
 * The fake pools below are real EventEmitters, so `emit("error")` throws
 * exactly like the drivers' pools would if the connector forgot the listener.
 */

class FakePgPool extends EventEmitter {
  connect = vi.fn().mockResolvedValue({ release: vi.fn() });
  end = vi.fn().mockResolvedValue(undefined);
}

class FakeMariadbPool extends EventEmitter {
  query = vi.fn().mockResolvedValue([{ version: "11.4.0-MariaDB" }]);
  end = vi.fn().mockResolvedValue(undefined);
}

let pgPool: FakePgPool;
let mariadbPool: FakeMariadbPool;

vi.mock("pg", () => ({
  default: {
    Pool: function (this: any) {
      return pgPool;
    },
  },
}));

vi.mock("mariadb", () => ({
  createPool: () => mariadbPool,
}));

const { PostgresConnector } = await import("../postgres/index.js");
const { MariaDBConnector } = await import("../mariadb/index.js");

const IDLE_DROP = new Error("terminating connection due to administrator command");

const spyConsoleError = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("pool 'error' listener", () => {
  let consoleError: ReturnType<typeof spyConsoleError>;

  beforeEach(() => {
    pgPool = new FakePgPool();
    mariadbPool = new FakeMariadbPool();
    consoleError = spyConsoleError();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an unlistened pool would crash the process (sanity check of the fake)", () => {
    expect(() => pgPool.emit("error", IDLE_DROP)).toThrow(IDLE_DROP);
  });

  it("PostgreSQL survives an idle connection being dropped", async () => {
    const connector = new PostgresConnector();
    await connector.connect("postgres://u:p@localhost:5432/db");

    expect(pgPool.listenerCount("error")).toBe(1);
    // Mirrors pg-pool's idleListener: the client is already purged, then the
    // pool re-emits. With no listener this emit would throw.
    expect(() => pgPool.emit("error", IDLE_DROP, {})).not.toThrow();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0].join(" ")).toContain("PostgreSQL pool");
    expect(consoleError.mock.calls[0].join(" ")).toContain(IDLE_DROP.message);

    await connector.disconnect();
  });

  it("PostgreSQL log line names the source", async () => {
    const connector = new PostgresConnector();
    (connector as any).sourceId = "prod_pg";
    await connector.connect("postgres://u:p@localhost:5432/db");

    pgPool.emit("error", IDLE_DROP, {});
    expect(consoleError.mock.calls[0][0]).toContain('source "prod_pg"');
  });

  it("MariaDB survives a background reconnect failure", async () => {
    const connector = new MariaDBConnector();
    await connector.connect("mariadb://u:p@localhost:3306/db");

    expect(mariadbPool.listenerCount("error")).toBe(1);
    const reconnectFailure = new Error("Pool fails to create connection: ECONNREFUSED");
    expect(() => mariadbPool.emit("error", reconnectFailure)).not.toThrow();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0].join(" ")).toContain("MariaDB pool");
    expect(consoleError.mock.calls[0].join(" ")).toContain(reconnectFailure.message);

    await connector.disconnect();
  });

  it("does not stack listeners across reconnects of the same connector", async () => {
    const connector = new PostgresConnector();
    await connector.connect("postgres://u:p@localhost:5432/db");
    await connector.disconnect();

    // A fresh pool per connect(): the listener is attached to the new pool.
    pgPool = new FakePgPool();
    await connector.connect("postgres://u:p@localhost:5432/db");
    expect(pgPool.listenerCount("error")).toBe(1);
  });
});
