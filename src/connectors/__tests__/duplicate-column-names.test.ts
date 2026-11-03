import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

/**
 * Driver-level coverage for repeated column names (bytebase/dbhub#484).
 *
 * The integration suites run `SELECT COUNT(*) AS n, COUNT(*) + 1 AS n` against
 * every engine; these tests pin how each connector asks its driver for rows
 * (array row mode, with the column metadata) and rebuilds the objects, using
 * the shapes the drivers return for `SELECT 1 AS a, 2 AS a`.
 */

const DUPLICATE_SQL = "SELECT 1 AS a, 2 AS a";

let pool: FakePgPool;

vi.mock("pg", () => ({
  default: {
    Pool: function () {
      return pool;
    },
    types: { builtins: {}, getTypeParser: () => (value: string) => value },
  },
}));

class FakePgPool extends EventEmitter {
  queries: any[] = [];
  release = vi.fn();
  client = Object.assign(new EventEmitter(), {
    processID: 1,
    query: vi.fn(async (query: any) => {
      this.queries.push(query);
      if (typeof query === "string") {
        return { rows: [], rowCount: null };
      }
      // node-postgres in rowMode 'array': rows positional, fields complete.
      return {
        rows: [[1, 2]],
        rowCount: 1,
        fields: [{ name: "a" }, { name: "a" }],
      };
    }),
    release: this.release as (err?: Error | boolean) => void,
  });
  connect = vi.fn(async () => {
    this.client.release = this.release;
    return this.client;
  });
  query = vi.fn();
  end = vi.fn().mockResolvedValue(undefined);
}

describe("PostgreSQL", () => {
  beforeEach(() => {
    pool = new FakePgPool();
  });

  async function connect() {
    const { PostgresConnector } = await import("../postgres/index.js");
    const connector = new PostgresConnector();
    await connector.connect("postgres://u:p@localhost:5432/db");
    pool.queries.length = 0;
    return connector;
  }

  it.each([
    ["autocommit", { readonly: false }],
    ["read-only transaction", { readonly: true }],
  ])("keeps both columns on the %s path", async (_label, options) => {
    const connector = await connect();
    const result = await connector.executeSQL(DUPLICATE_SQL, options);
    expect(result.resultSets[0]).toEqual({ sql: DUPLICATE_SQL, rows: [{ a: 1, a_1: 2 }], rowCount: 1 });
  });

  it("keeps both columns in a multi-statement batch", async () => {
    const connector = await connect();
    const result = await connector.executeSQL(`${DUPLICATE_SQL}; ${DUPLICATE_SQL}`, {});
    expect(result.resultSets.map((set) => set.rows)).toEqual([[{ a: 1, a_1: 2 }], [{ a: 1, a_1: 2 }]]);
  });

  it("asks the driver for positional rows and passes parameters through", async () => {
    const connector = await connect();
    await connector.executeSQL("SELECT $1 AS a, $2 AS a", {}, [1, 2]);
    expect(pool.queries).toContainEqual({ text: "SELECT $1 AS a, $2 AS a", values: [1, 2], rowMode: "array" });
  });
});

describe("SQL Server", () => {
  it("rebuilds object rows from an array-row-mode recordset", async () => {
    const { SQLServerConnector } = await import("../sqlserver/index.js");
    // node-mssql in arrayRowMode: positional rows, `columns` as a list.
    const recordset: any = [[1, 2]];
    Object.defineProperty(recordset, "columns", { value: [{ name: "a" }, { name: "a" }], enumerable: false });
    const sets = (SQLServerConnector as any).buildResultSets([recordset], [1], DUPLICATE_SQL, undefined);
    expect(sets).toEqual([{ sql: DUPLICATE_SQL, rows: [{ a: 1, a_1: 2 }], rowCount: 1 }]);
  });

  it("reads a chunked FOR JSON row positionally", async () => {
    const { SQLServerConnector } = await import("../sqlserver/index.js");
    // node-mssql assembles a FOR JSON/XML result into a single-key object
    // even in arrayRowMode (keyed "0"), with the chunk column in `columns`.
    const recordset: any = [{ "0": '[{"a":1}]' }];
    Object.defineProperty(recordset, "columns", {
      value: [{ name: "JSON_F52E2B61-18A1-11d1-B105-00805F49916B" }],
      enumerable: false,
    });
    const sets = (SQLServerConnector as any).buildResultSets([recordset], [1], undefined, undefined);
    expect(sets[0].rows).toEqual([{ "JSON_F52E2B61-18A1-11d1-B105-00805F49916B": '[{"a":1}]' }]);
  });
});
