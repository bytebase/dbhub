import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HanaConnector } from "../hana/index.js";

/**
 * SAP HANA integration tests.
 *
 * SAP HANA 2.0 cannot run in a local container the way the other connectors'
 * Testcontainers-based suites do (HANA Express is x86_64-only and heavyweight),
 * so this suite runs against a REAL, reachable HANA instance and is skipped
 * unless a DSN is supplied:
 *
 *   HANA_DSN="hana://user:pass@host:30015?encrypt=true&sslmode=verify-full" \
 *     pnpm test:integration src/connectors/__tests__/hana.integration.test.ts
 *
 * All assertions read only from the SYS catalog, so no write privileges or test
 * fixtures are required — any HANA login can run them.
 */
const HANA_DSN = process.env.HANA_DSN;

describe.skipIf(!HANA_DSN)("SAP HANA (integration)", () => {
  const connector = new HanaConnector();

  beforeAll(async () => {
    await connector.connect(HANA_DSN as string);
  });

  afterAll(async () => {
    await connector.disconnect();
  });

  it("executes a simple SELECT", async () => {
    const result = await connector.executeSQL("SELECT 1 AS N FROM SYS.DUMMY", {});
    expect(result.rows).toEqual([{ N: 1 }]);
    expect(result.rowCount).toBe(1);
  });

  it("returns the default (current) schema", async () => {
    const schema = await connector.getDefaultSchema();
    expect(typeof schema).toBe("string");
    expect(schema).toBeTruthy();
  });

  it("lists schemas including SYS", async () => {
    const schemas = await connector.getSchemas();
    expect(Array.isArray(schemas)).toBe(true);
    expect(schemas).toContain("SYS");
  });

  it("lists views in the SYS schema", async () => {
    const views = await connector.getViews("SYS");
    expect(views.length).toBeGreaterThan(0);
    expect(views).toContain("SCHEMAS");
  });

  it("reports that the SYS.SCHEMAS view exists", async () => {
    expect(await connector.tableExists("SCHEMAS", "SYS")).toBe(true);
    expect(await connector.tableExists("DEFINITELY_NOT_A_REAL_OBJECT", "SYS")).toBe(false);
  });

  it("describes columns of a SYS view", async () => {
    const columns = await connector.getTableSchema("SCHEMAS", "SYS");
    const names = columns.map((c) => c.column_name);
    expect(names).toContain("SCHEMA_NAME");
    // Every column carries the normalized nullability string.
    for (const col of columns) {
      expect(["YES", "NO"]).toContain(col.is_nullable);
    }
  });

  it("applies maxRows to SELECT queries", async () => {
    const result = await connector.executeSQL("SELECT SCHEMA_NAME FROM SYS.SCHEMAS", {
      maxRows: 1,
    });
    expect(result.rows.length).toBeLessThanOrEqual(1);
  });

  it("executes SELECT in read-only mode", async () => {
    const result = await connector.executeSQL("SELECT 1 AS N FROM SYS.DUMMY", { readonly: true });
    expect(result.rows).toEqual([{ N: 1 }]);
  });

  it("rejects writes in read-only mode", async () => {
    await expect(
      connector.executeSQL("CREATE TABLE dbhub_hana_readonly_probe (id INT)", { readonly: true })
    ).rejects.toBeTruthy();
  });

  it("restores a writable session after a read-only call", async () => {
    // Regression for the read-only session-state leak: a read-only execution
    // must not leave the shared connection stuck read-only. Verify with a
    // LOCAL TEMPORARY table — session-scoped, invisible to others, auto-dropped.
    await connector.executeSQL("SELECT 1 FROM DUMMY", { readonly: true });
    await connector.executeSQL("CREATE LOCAL TEMPORARY TABLE #DBHUB_RW_PROBE (ID INT)", {});
    await connector.executeSQL("DROP TABLE #DBHUB_RW_PROBE", {});
  });
});
