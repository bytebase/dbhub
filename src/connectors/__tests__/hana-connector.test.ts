import { describe, it, expect, vi } from "vitest";

// Inject a fake @sap/hana-client so the connector's lazy `import()` resolves to
// a controllable mock (no native driver required).
const hoisted = vi.hoisted(() => ({ current: null as unknown as MockConn }));
vi.mock("@sap/hana-client", () => ({
  // The connector reads `mod.default ?? mod`, so provide both a default and a
  // named export (vitest throws on accessing an undefined `default`).
  default: { createConnection: () => hoisted.current },
  createConnection: () => hoisted.current,
}));

import { HanaConnector } from "../hana/index.js";

/** Records every driver interaction so tests can assert the exact sequence. */
class MockConn {
  execLog: string[] = [];
  autoCommitLog: boolean[] = [];
  rollbackCount = 0;
  disconnectCount = 0;
  connectShouldFail: Error | null = null;

  connect(_params: unknown, cb: (e: Error | null) => void): void {
    cb(this.connectShouldFail);
  }
  exec(sql: string, _params: unknown[], cb: (e: Error | null, rows: unknown) => void): void {
    this.execLog.push(sql.replace(/\s+/g, " ").trim());
    cb(null, []);
  }
  prepare(sql: string, cb: (e: Error | null, stmt: unknown) => void): void {
    cb(null, {
      setTimeout: () => {},
      exec: (_p: unknown[], c: (e: Error | null, rows: unknown) => void) => {
        this.execLog.push(sql.replace(/\s+/g, " ").trim());
        c(null, []);
      },
      drop: (c?: (e: Error | null) => void) => c?.(null),
    });
  }
  disconnect(cb?: (e: Error | null) => void): void {
    this.disconnectCount++;
    cb?.(null);
  }
  setAutoCommit(b: boolean): void {
    this.autoCommitLog.push(b);
  }
  rollback(cb: (e: Error | null) => void): void {
    this.rollbackCount++;
    cb(null);
  }
}

async function connected(mock: MockConn): Promise<HanaConnector> {
  hoisted.current = mock;
  const connector = new HanaConnector();
  await connector.connect("hana://u:p@h:30015");
  return connector;
}

describe("HanaConnector (mocked driver)", () => {
  it("read-only execution restores READ WRITE + autocommit afterwards", async () => {
    const mock = new MockConn();
    const connector = await connected(mock);

    await connector.executeSQL("SELECT 1 AS N FROM DUMMY", { readonly: true });

    expect(mock.execLog).toEqual([
      "SET TRANSACTION READ ONLY",
      "SELECT 1 AS N FROM DUMMY",
      "SET TRANSACTION READ WRITE",
    ]);
    expect(mock.autoCommitLog).toEqual([false, true]);
    expect(mock.rollbackCount).toBe(2);
  });

  it("rejects parameters combined with multiple statements", async () => {
    const mock = new MockConn();
    const connector = await connected(mock);
    await expect(connector.executeSQL("SELECT ?; SELECT ?", {}, [1, 2])).rejects.toThrow(
      /multiple statements/
    );
  });

  it("does not split procedural DDL on internal semicolons", async () => {
    const mock = new MockConn();
    const connector = await connected(mock);
    const ddl = "CREATE OR REPLACE PROCEDURE FOO AS BEGIN DELETE FROM t1; DELETE FROM t2; END;";

    await connector.executeSQL(ddl, {});

    expect(mock.execLog).toHaveLength(1);
    expect(mock.execLog[0]).toContain("CREATE OR REPLACE PROCEDURE");
    expect(mock.execLog[0]).toContain("DELETE FROM t2");
  });

  it("still splits ordinary multi-statement scripts", async () => {
    const mock = new MockConn();
    const connector = await connected(mock);
    await connector.executeSQL("SELECT 1 FROM DUMMY; SELECT 2 FROM DUMMY", {});
    expect(mock.execLog).toEqual(["SELECT 1 FROM DUMMY", "SELECT 2 FROM DUMMY"]);
  });

  it("cleans up (disconnects) when connect fails", async () => {
    const mock = new MockConn();
    mock.connectShouldFail = new Error("connect boom");
    hoisted.current = mock;
    const connector = new HanaConnector();

    await expect(connector.connect("hana://u:p@h:30015")).rejects.toThrow("connect boom");
    expect(mock.disconnectCount).toBe(1);
    // The connection field is cleared, so later calls report "not connected".
    await expect(connector.executeSQL("SELECT 1 FROM DUMMY", {})).rejects.toThrow(/Not connected/);
  });

  it("caps rows for a CTE (WITH … SELECT) that the plain limiter would miss", async () => {
    const mock = new MockConn();
    const connector = await connected(mock);
    await connector.executeSQL("WITH c AS (SELECT 1 AS N FROM DUMMY) SELECT * FROM c", {
      maxRows: 5,
    });
    expect(mock.execLog).toHaveLength(1);
    expect(mock.execLog[0]).toMatch(/LIMIT 5/);
  });
});
