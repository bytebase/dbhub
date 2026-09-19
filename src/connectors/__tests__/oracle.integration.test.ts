import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OracleDbContainer, StartedOracleDbContainer } from '@testcontainers/oraclefree';
import { OracleConnector } from '../oracle/index.js';
import { IntegrationTestBase, type TestContainer, type DatabaseTestConfig } from './shared/integration-test-base.js';
import type { Connector } from '../interface.js';

// Oracle Database 23ai Free. The `faststart` variant ships with the database
// already expanded, trading a larger pull for a much shorter startup.
const ORACLE_IMAGE = 'gvenzl/oracle-free:23-slim-faststart';
const APP_USER = 'test';
const APP_PASSWORD = 'test';

class OracleTestContainer implements TestContainer {
  constructor(private container: StartedOracleDbContainer) {}

  getConnectionUri(): string {
    // oracle://user:password@host:port/service
    return `oracle://${APP_USER}:${APP_PASSWORD}@${this.container.getHost()}:${this.container.getPort()}/${this.container.getDatabase()}`;
  }

  async stop(): Promise<void> {
    await this.container.stop();
  }
}

class OracleIntegrationTest extends IntegrationTestBase<OracleTestContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      // Every Oracle user is a schema; the container's application user is
      // the session's default schema.
      expectedSchemas: [APP_USER.toUpperCase()],
      // Unquoted identifiers are folded to upper case by Oracle.
      expectedTables: ['USERS', 'ORDERS', 'PRODUCTS'],
      supportsStoredProcedures: true,
      expectedStoredProcedures: ['GET_USER_COUNT', 'CALCULATE_TOTAL_AGE'],
      supportsComments: true,
    };
    super(config);
  }

  async createContainer(): Promise<OracleTestContainer> {
    const container = await new OracleDbContainer(ORACLE_IMAGE)
      .withUsername(APP_USER)
      .withPassword(APP_PASSWORD)
      .withStartupTimeout(300_000)
      .start();

    return new OracleTestContainer(container);
  }

  createConnector(): Connector {
    return new OracleConnector();
  }

  async setupTestData(connector: Connector): Promise<void> {
    await connector.executeSQL(`
      CREATE TABLE users (
        id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name VARCHAR2(100) NOT NULL,
        email VARCHAR2(100) UNIQUE NOT NULL,
        age NUMBER
      )
    `, {});

    await connector.executeSQL(`
      CREATE TABLE orders (
        id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id NUMBER,
        total NUMBER(10,2),
        created_at TIMESTAMP DEFAULT SYSTIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `, {});

    await connector.executeSQL(`
      CREATE TABLE products (
        id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        name VARCHAR2(100) NOT NULL,
        price NUMBER(10,2)
      )
    `, {});

    await connector.executeSQL(`CREATE VIEW active_users AS SELECT id, name FROM users WHERE age IS NOT NULL`, {});

    // Table and column comments
    await connector.executeSQL(`COMMENT ON TABLE users IS 'Application users'`, {});
    await connector.executeSQL(`COMMENT ON COLUMN users.name IS 'Full name of the user'`, {});
    await connector.executeSQL(`COMMENT ON COLUMN users.email IS 'Unique email address'`, {});

    // One batch of several statements: exercises the connector's splitting.
    await connector.executeSQL(`
      INSERT INTO users (name, email, age) VALUES ('John Doe', 'john@example.com', 30);
      INSERT INTO users (name, email, age) VALUES ('Jane Smith', 'jane@example.com', 25);
      INSERT INTO users (name, email, age) VALUES ('Bob Johnson', 'bob@example.com', 35);
    `, {});

    await connector.executeSQL(`
      INSERT INTO orders (user_id, total) VALUES (1, 99.99);
      INSERT INTO orders (user_id, total) VALUES (1, 149.50);
      INSERT INTO orders (user_id, total) VALUES (2, 75.25);
    `, {});

    await connector.executeSQL(`
      INSERT INTO products (name, price) VALUES ('Widget A', 19.99);
      INSERT INTO products (name, price) VALUES ('Widget B', 29.99);
    `, {});

    // A function and a procedure: PL/SQL bodies must reach the server whole,
    // internal semicolons included.
    await connector.executeSQL(`
      CREATE OR REPLACE FUNCTION get_user_count RETURN NUMBER IS
        n NUMBER;
      BEGIN
        SELECT COUNT(*) INTO n FROM users;
        RETURN n;
      END;
    `, {});

    await connector.executeSQL(`
      CREATE OR REPLACE PROCEDURE calculate_total_age(p_total OUT NUMBER) IS
      BEGIN
        SELECT NVL(SUM(age), 0) INTO p_total FROM users WHERE age IS NOT NULL;
      END;
    `, {});
  }
}

const oracleTest = new OracleIntegrationTest();

describe('Oracle Connector Integration Tests', () => {
  beforeAll(async () => {
    await oracleTest.setup();
  }, 360_000); // image pull + database startup

  afterAll(async () => {
    await oracleTest.cleanup();
  });

  oracleTest.createConnectionTests();
  oracleTest.createSchemaTests();
  oracleTest.createTableTests();
  oracleTest.createSQLExecutionTests();
  if (oracleTest.config.supportsStoredProcedures) {
    oracleTest.createStoredProcedureTests();
  }
  oracleTest.createCommentTests();
  oracleTest.createErrorHandlingTests();

  describe('Oracle-specific: identifier case', () => {
    it('finds tables and columns by their unquoted (lower-case) DDL spelling', async () => {
      expect(await oracleTest.connector.tableExists('users')).toBe(true);
      expect(await oracleTest.connector.tableExists('USERS')).toBe(true);
      expect(await oracleTest.connector.tableExists('users', 'test')).toBe(true);
      // Mixed case is taken as spelled (a quoted identifier), so this is a different name.
      expect(await oracleTest.connector.tableExists('Users')).toBe(false);

      const columns = await oracleTest.connector.getTableSchema('users');
      expect(columns.map((c) => c.column_name)).toEqual(['ID', 'NAME', 'EMAIL', 'AGE']);
    });

    it('renders column types the way DDL spells them', async () => {
      await oracleTest.connector.executeSQL(
        'CREATE TABLE type_probe (i INTEGER, s NUMBER(*,2), f FLOAT(10), v NVARCHAR2(20), r RAW(16))',
        {}
      );
      const probe = Object.fromEntries(
        (await oracleTest.connector.getTableSchema('type_probe')).map((c) => [c.column_name, c.data_type])
      );
      expect(probe).toEqual({ I: 'NUMBER(*,0)', S: 'NUMBER(*,2)', F: 'FLOAT(10)', V: 'NVARCHAR2(20)', R: 'RAW(16)' });

      const columns = await oracleTest.connector.getTableSchema('orders');
      const byName = Object.fromEntries(columns.map((c) => [c.column_name, c]));
      expect(byName.TOTAL.data_type).toBe('NUMBER(10,2)');
      expect(byName.USER_ID.data_type).toBe('NUMBER');
      expect(byName.CREATED_AT.data_type).toBe('TIMESTAMP(6)');
      expect(byName.CREATED_AT.column_default).toBe('SYSTIMESTAMP');
      expect(byName.ID.is_nullable).toBe('NO');
    });

    it('lists views separately from tables', async () => {
      expect(await oracleTest.connector.getViews()).toContain('ACTIVE_USERS');
      expect(await oracleTest.connector.getTables()).not.toContain('ACTIVE_USERS');
    });

    it('reports the connected user as the default schema', async () => {
      expect(await oracleTest.connector.getDefaultSchema!()).toBe('TEST');
    });
  });

  describe('Oracle-specific: stored procedure detail', () => {
    it('returns the OUT parameter and PL/SQL source of a procedure', async () => {
      const proc = await oracleTest.connector.getStoredProcedureDetail('calculate_total_age');
      expect(proc.procedure_type).toBe('procedure');
      expect(proc.language).toBe('plsql');
      expect(proc.parameter_list).toBe('P_TOTAL OUT NUMBER');
      expect(proc.return_type).toBeUndefined();
      expect(proc.definition).toContain('NVL(SUM(age), 0)');
    });

    it('returns the return type of a function', async () => {
      const fn = await oracleTest.connector.getStoredProcedureDetail('GET_USER_COUNT');
      expect(fn.procedure_type).toBe('function');
      expect(fn.return_type).toBe('NUMBER');
      expect(fn.parameter_list).toBe('');
    });

    it('filters by routine type', async () => {
      expect(await oracleTest.connector.getStoredProcedures(undefined, 'function')).toEqual(['GET_USER_COUNT']);
      expect(await oracleTest.connector.getStoredProcedures(undefined, 'procedure')).toEqual(['CALCULATE_TOTAL_AGE']);
    });
  });

  describe('Oracle-specific: SQL execution', () => {
    it('binds positional :1 parameters', async () => {
      const result = await oracleTest.connector.executeSQL(
        'SELECT name FROM users WHERE email = :1',
        {},
        ['jane@example.com']
      );
      expect(result.resultSets[0].rows).toEqual([{ NAME: 'Jane Smith' }]);
    });

    it('binds repeated and reordered placeholders by name, per statement', async () => {
      const result = await oracleTest.connector.executeSQL(
        `SELECT :2 AS a, :1 AS b, :1 AS c FROM dual;
         SELECT :1 AS only FROM dual`,
        {},
        ['one', 'two']
      );
      expect(result.resultSets[0].rows).toEqual([{ A: 'two', B: 'one', C: 'one' }]);
      expect(result.resultSets[1].rows).toEqual([{ ONLY: 'one' }]);
    });

    it('fetches BLOB columns as Buffers and preserves driver error codes', async () => {
      const blob = await oracleTest.connector.executeSQL(
        "SELECT TO_BLOB(HEXTORAW('DEADBEEF')) AS b FROM dual",
        {}
      );
      expect(Buffer.isBuffer(blob.resultSets[0].rows[0].B)).toBe(true);
      expect((blob.resultSets[0].rows[0].B as Buffer).toString('hex')).toBe('deadbeef');

      await expect(
        oracleTest.connector.executeSQL('SELECT * FROM nonexistent_table', {})
      ).rejects.toMatchObject({ code: 'ORA-00942' });
    });

    it('returns one result set per statement in a batch, with affected counts for writes', async () => {
      const result = await oracleTest.connector.executeSQL(`
        INSERT INTO products (name, price) VALUES ('Widget C', 9.99);
        SELECT COUNT(*) AS n FROM products WHERE name LIKE 'Widget%';
        DELETE FROM products WHERE name = 'Widget C';
      `, {});
      expect(result.resultSets).toHaveLength(3);
      expect(result.resultSets[0]).toMatchObject({ rowCount: 1, rows: [] });
      expect(Number(result.resultSets[1].rows[0].N)).toBe(3);
      expect(result.resultSets[2]).toMatchObject({ rowCount: 1, rows: [] });
    });

    it('accepts a trailing semicolon on a plain statement', async () => {
      const result = await oracleTest.connector.executeSQL('SELECT 1 AS one FROM dual;', {});
      expect(result.resultSets[0].rows).toEqual([{ ONE: 1 }]);
    });

    it('runs an anonymous PL/SQL block as a single statement', async () => {
      const result = await oracleTest.connector.executeSQL(`
        BEGIN
          UPDATE products SET price = price WHERE 1 = 0;
        END;
      `, {});
      expect(result.resultSets).toHaveLength(1);
    });

    it('keeps a PL/SQL block whole in the middle of a mixed batch', async () => {
      const result = await oracleTest.connector.executeSQL(`
        INSERT INTO products (name, price) VALUES ('Widget D', 1);
        DECLARE
          n NUMBER;
        BEGIN
          SELECT COUNT(*) INTO n FROM products WHERE name = 'Widget D';
          IF n = 1 THEN
            UPDATE products SET price = 2 WHERE name = 'Widget D';
          END IF;
        END;
        SELECT price FROM products WHERE name = 'Widget D';
        DELETE FROM products WHERE name = 'Widget D';
      `, {});
      expect(result.resultSets).toHaveLength(4);
      expect(Number(result.resultSets[2].rows[0].PRICE)).toBe(2);
    });

    it('caps rows with maxRows and flags truncation exactly', async () => {
      const capped = await oracleTest.connector.executeSQL('SELECT * FROM users ORDER BY id', { maxRows: 2 });
      expect(capped.resultSets[0].rows).toHaveLength(2);
      expect(capped.resultSets[0].truncated).toBe(true);

      const uncapped = await oracleTest.connector.executeSQL('SELECT * FROM products ORDER BY id', { maxRows: 50 });
      expect(uncapped.resultSets[0].truncated).toBeUndefined();
    });

    it('preserves NUMBER integers beyond 2^53 and keeps decimals numeric', async () => {
      const result = await oracleTest.connector.executeSQL(
        'SELECT 9007199254740993 AS big, 42 AS small, 1.5 AS dec, NULL AS none FROM dual',
        {}
      );
      expect(result.resultSets[0].rows[0]).toEqual({
        BIG: 9007199254740993n,
        SMALL: 42,
        DEC: 1.5,
        NONE: null,
      });
    });

    it('keeps a q-quoted literal intact', async () => {
      const result = await oracleTest.connector.executeSQL(`SELECT q'[it's; fine]' AS s FROM dual`, {});
      expect(result.resultSets[0].rows).toEqual([{ S: "it's; fine" }]);
    });
  });

  describe('Oracle-specific: read-only backstop', () => {
    it('rejects DML inside a READ ONLY transaction and persists nothing', async () => {
      await expect(
        oracleTest.connector.executeSQL(
          "INSERT INTO products (name, price) VALUES ('Sneaky', 1)",
          { readonly: true }
        )
      ).rejects.toThrow(/ORA-01456/);

      const check = await oracleTest.connector.executeSQL(
        "SELECT COUNT(*) AS n FROM products WHERE name = 'Sneaky'",
        { readonly: true }
      );
      expect(Number(check.resultSets[0].rows[0].N)).toBe(0);
    });

    it('still serves reads with the backstop engaged', async () => {
      const result = await oracleTest.connector.executeSQL('SELECT COUNT(*) AS n FROM users', { readonly: true, maxRows: 10 });
      expect(Number(result.resultSets[0].rows[0].N)).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Oracle-specific: health check', () => {
    // The image gives SYSTEM the same password as the application user, so
    // the test can shape privileges deterministically: grant the app user
    // the catalog role (privileged path) and create a user without it
    // (restricted path).
    const RESTRICTED_USER = 'dbhub_restricted';
    let restricted: Connector;

    beforeAll(async () => {
      const admin = new OracleConnector();
      await admin.connect(oracleTest.connectionString.replace(`${APP_USER}:${APP_PASSWORD}@`, `system:${APP_PASSWORD}@`));
      try {
        await admin.executeSQL(`GRANT SELECT_CATALOG_ROLE TO ${APP_USER}`, {});
        await admin.executeSQL(`CREATE USER ${RESTRICTED_USER} IDENTIFIED BY "${APP_PASSWORD}"`, {});
        await admin.executeSQL(`GRANT CREATE SESSION TO ${RESTRICTED_USER}`, {});
      } finally {
        await admin.disconnect();
      }

      // A fresh pool so the new role applies to every session it opens.
      await oracleTest.connector.disconnect();
      await oracleTest.connector.connect(oracleTest.connectionString);

      restricted = new OracleConnector();
      await restricted.connect(oracleTest.connectionString.replace(`${APP_USER}:${APP_PASSWORD}@`, `${RESTRICTED_USER}:${APP_PASSWORD}@`));
    });

    afterAll(async () => {
      await restricted?.disconnect();
    });

    it('reports connection pool state and buffer cache hit ratio with SELECT_CATALOG_ROLE', async () => {
      const health = await oracleTest.connector.getHealthCheck!();
      expect(health.notes).toBeUndefined();

      expect(health.connections).toBeDefined();
      expect(health.connections!.total).toBeGreaterThanOrEqual(0);
      expect(health.connections!.active).toBeGreaterThanOrEqual(0);
      expect(health.connections!.idle).toBeGreaterThanOrEqual(0);
      expect(health.connections!.active + health.connections!.idle).toBeLessThanOrEqual(health.connections!.total);
      expect(health.connections!.idleInTransaction).toBeGreaterThanOrEqual(0);
      expect(health.connections!.idleInTransactionAborted).toBeUndefined();
      expect(health.connections!.maxConnections).toBeGreaterThan(0);

      expect(health.bufferCache).toBeDefined();
      expect(health.bufferCache!.blocksHit + health.bufferCache!.blocksRead).toBeGreaterThan(0);
      expect(health.bufferCache!.hitRatioPct).not.toBeNull();
      expect(health.bufferCache!.hitRatioPct).toBeGreaterThanOrEqual(0);
      expect(health.bufferCache!.hitRatioPct).toBeLessThanOrEqual(100);
    });

    it('degrades to notes, not an error, without the catalog role', async () => {
      const health = await restricted.getHealthCheck!();

      expect(health.connections).toBeUndefined();
      expect(health.bufferCache).toBeUndefined();
      expect(health.notes).toEqual([
        expect.stringContaining('V$SESSION'),
        expect.stringContaining('V$SYSSTAT'),
      ]);
    });
  });

  describe('Oracle-specific: EXPLAIN', () => {
    it('returns an execution plan for a bare EXPLAIN without executing the statement', async () => {
      const result = await oracleTest.connector.executeSQL('EXPLAIN SELECT * FROM users WHERE id = 1', { readonly: true });
      expect(result.resultSets[0].rowCount).toBe(1);
      expect(result.resultSets[0].rows[0].plan).toContain('USERS');
    });

    it("accepts Oracle's native EXPLAIN PLAN FOR form", async () => {
      const result = await oracleTest.connector.executeSQL('EXPLAIN PLAN FOR SELECT name FROM users', {});
      expect(result.resultSets[0].rows[0].plan).toContain('USERS');
    });

    it('refuses to explain a write in read-only mode', async () => {
      await expect(
        oracleTest.connector.executeSQL("EXPLAIN DELETE FROM users", { readonly: true })
      ).rejects.toThrow(/Read-only mode/);
    });
  });
});
