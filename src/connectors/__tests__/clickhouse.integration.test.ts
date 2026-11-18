import { describe, it, expect } from 'vitest';
import { ClickHouseContainer, StartedClickHouseContainer } from '@testcontainers/clickhouse';
import { ClickHouseConnector } from '../clickhouse/index.js';
import { IntegrationTestBase, type TestContainer, type DatabaseTestConfig } from './shared/integration-test-base.js';
import type { Connector } from '../interface.js';
import { classifyConnectionError } from '../../utils/error-classifier.js';

// An LTS release. The connector relies on nothing newer than lightweight
// DELETE (23.3), which only the shared write tests use.
const CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:25.8';
const APP_USER = 'test';
const APP_PASSWORD = 'test';
const APP_DATABASE = 'test';

class ClickHouseTestContainer implements TestContainer {
  constructor(private container: StartedClickHouseContainer) {}

  /** DSN for `user` on the container's HTTP interface. */
  dsnFor(user: string, password: string, database = APP_DATABASE): string {
    return `clickhouse://${user}:${password}@${this.container.getHost()}:${this.container.getHttpPort()}/${database}`;
  }

  getConnectionUri(): string {
    return this.dsnFor(APP_USER, APP_PASSWORD);
  }

  async stop(): Promise<void> {
    await this.container.stop();
  }
}

class ClickHouseIntegrationTest extends IntegrationTestBase<ClickHouseTestContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      // A ClickHouse database is a schema.
      expectedSchemas: [APP_DATABASE, 'test_schema'],
      expectedTables: ['users', 'orders', 'events'],
      expectedTestSchemaTable: 'products',
      testSchema: 'test_schema',
      // SQL user-defined functions stand in for stored routines.
      supportsStoredProcedures: true,
      expectedStoredProcedures: ['dbhub_user_label', 'dbhub_add'],
      supportsComments: true,
      // readonly = 1 makes the server itself reject the write.
      readonlyWriteError: /readonly mode/,
    };
    super(config);
  }

  async createContainer(): Promise<ClickHouseTestContainer> {
    const container = await new ClickHouseContainer(CLICKHOUSE_IMAGE)
      .withUsername(APP_USER)
      .withPassword(APP_PASSWORD)
      .withDatabase(APP_DATABASE)
      // Lets the application user create the read-only users the tests need.
      .withEnvironment({ CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' })
      .start();

    return new ClickHouseTestContainer(container);
  }

  createConnector(): Connector {
    return new ClickHouseConnector();
  }

  /** DSN for another user, or another database, of the same container. */
  dsnFor(user: string, password: string, database?: string): string {
    return this.container.dsnFor(user, password, database);
  }

  async setupTestData(connector: Connector): Promise<void> {
    // ClickHouse has no auto-increment. Rows the shared tests insert without an
    // id get one far above the seeded 1..3, so `ORDER BY id` keeps the seed
    // rows first, as it does on engines that number rows in insertion order.
    await connector.executeSQL(`
      CREATE TABLE users (
        id UInt64 DEFAULT 1000000 + rand64() % 1000000,
        name String COMMENT 'Full name of the user',
        email String COMMENT 'Unique email address',
        age Nullable(UInt8)
      ) ENGINE = MergeTree ORDER BY id COMMENT 'Application users'
    `, {});

    await connector.executeSQL(`
      CREATE TABLE orders (
        id UInt64,
        user_id UInt64,
        total Decimal(10, 2),
        created_at DateTime DEFAULT now()
      ) ENGINE = MergeTree ORDER BY id
    `, {});

    // A table shaped the way analytical tables are: a primary key that is a
    // prefix of the sorting key, expressions in both, computed columns, a
    // skipping index, and a versioned engine.
    await connector.executeSQL(`
      CREATE TABLE events (
        tenant_id UInt32,
        ts DateTime,
        id UInt64,
        url String,
        payload Nullable(String),
        kind LowCardinality(Nullable(String)) DEFAULT 'view',
        day Date MATERIALIZED toDate(ts),
        host String ALIAS domain(url),
        version UInt64,
        INDEX idx_url lower(url) TYPE bloom_filter GRANULARITY 4
      ) ENGINE = ReplacingMergeTree(version)
      PRIMARY KEY (tenant_id, toDate(ts))
      ORDER BY (tenant_id, toDate(ts), id)
    `, {});

    await connector.executeSQL(`
      CREATE VIEW active_users AS SELECT id, name FROM users WHERE age IS NOT NULL;
      CREATE TABLE events_per_day (tenant_id UInt32, day Date, events UInt64)
        ENGINE = SummingMergeTree ORDER BY (tenant_id, day);
      CREATE MATERIALIZED VIEW events_per_day_mv TO events_per_day AS
        SELECT tenant_id, toDate(ts) AS day, count() AS events FROM events GROUP BY tenant_id, day;
    `, {});

    await connector.executeSQL(`
      CREATE DATABASE test_schema;
      CREATE TABLE test_schema.products (id UInt64, name String, price Decimal(10, 2))
        ENGINE = MergeTree ORDER BY id;
    `, {});

    await connector.executeSQL(`
      INSERT INTO users (id, name, email, age) VALUES
        (1, 'John Doe', 'john@example.com', 30),
        (2, 'Jane Smith', 'jane@example.com', 25),
        (3, 'Bob Johnson', 'bob@example.com', 35);
      INSERT INTO orders (id, user_id, total) VALUES (1, 1, 99.99), (2, 1, 149.50), (3, 2, 75.25);
      INSERT INTO test_schema.products VALUES (1, 'Widget A', 19.99), (2, 'Widget B', 29.99);
      INSERT INTO events (tenant_id, ts, id, url, payload, version) VALUES
        (1, '2026-01-01 10:00:00', 1, 'https://example.com/a', NULL, 1),
        (1, '2026-01-01 11:00:00', 2, 'https://example.com/b', 'x', 1),
        (2, '2026-01-02 09:00:00', 3, 'https://other.example/c', 'y', 1);
    `, {});

    await connector.executeSQL(`
      CREATE FUNCTION dbhub_user_label AS (x) -> concat('user-', toString(x));
      CREATE FUNCTION dbhub_add AS (a, b) -> a + b;
    `, {});

    // Users whose own profile is read-only, at each of ClickHouse's two levels.
    // They are granted INSERT so that a refused write is refused for being
    // read-only, not for lacking the grant.
    await connector.executeSQL(`
      CREATE USER ro1 IDENTIFIED BY 'ro1pass' SETTINGS readonly = 1;
      CREATE USER ro2 IDENTIFIED BY 'ro2pass' SETTINGS readonly = 2;
      GRANT SELECT, INSERT ON ${APP_DATABASE}.* TO ro1, ro2;
    `, {});
  }
}

const clickhouseTest = new ClickHouseIntegrationTest();

/** The value under `key` of a result row. */
const value = (row: Record<string, unknown>, key: string): unknown => row[key];

describe('ClickHouse Connector Integration Tests', () => {
  clickhouseTest.registerLifecycle();

  // Every shared suite except SQL execution, which is replaced below: its
  // repeated-alias query (`COUNT(*) AS n, COUNT(*) + 1 AS n`) is one ClickHouse
  // rejects by design.
  clickhouseTest.createConnectionTests();
  clickhouseTest.createSchemaTests();
  clickhouseTest.createTableTests();
  clickhouseTest.createStoredProcedureTests();
  clickhouseTest.createCommentTests();
  clickhouseTest.createErrorHandlingTests();
  clickhouseTest.createMaxRowsTests();
  clickhouseTest.createReadonlyBackstopTests();

  describe('SQL Execution', () => {
    it('should execute INSERT and SELECT, reporting the rows written', async () => {
      const insert = await clickhouseTest.connector.executeSQL(
        "INSERT INTO users (name, email, age) VALUES ('Test User', 'test@example.com', 25)", {}
      );
      expect(insert.resultSets[0]).toMatchObject({ rows: [], rowCount: 1 });

      const select = await clickhouseTest.connector.executeSQL(
        "SELECT * FROM users WHERE email = 'test@example.com'", {}
      );
      expect(select.resultSets[0].rows).toHaveLength(1);
      expect(select.resultSets[0].rows[0]).toMatchObject({ name: 'Test User', age: 25 });
    });

    it('should keep every column when names repeat', async () => {
      // Two columns of one name: the same expression twice, and a join that
      // selects the key from both sides.
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT count(), count(), 1 AS one FROM users', {}
      );
      const row = result.resultSets[0].rows[0];
      expect(Object.keys(row)).toEqual(['count()', 'count()_1', 'one']);
      expect(Number(row['count()'])).toBeGreaterThanOrEqual(3);
      expect(row['count()_1']).toBe(row['count()']);
    });

    it('should return 64-bit integers exactly, small ones as numbers, and decimals as text', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        `SELECT toUInt64(18446744073709551615) AS big, toInt64(-9223372036854775808) AS small_end,
                toUInt64(42) AS answer, count() AS n, toDecimal64('1234567890.12', 2) AS amount,
                [toUInt64(9007199254740993), 1] AS ids, toFloat64(1.5) AS ratio,
                toDate('2026-01-02') AS day, CAST(NULL, 'Nullable(String)') AS nothing
         FROM users WHERE id <= 3`, {}
      );
      expect({ ...result.resultSets[0].rows[0] }).toEqual({
        big: '18446744073709551615',
        small_end: '-9223372036854775808',
        answer: 42,
        n: 3,
        amount: '1234567890.12',
        ids: ['9007199254740993', 1],
        ratio: 1.5,
        day: '2026-01-02',
        nothing: null,
      });
    });

    it('should return an empty result with no rows for a SELECT that matches nothing', async () => {
      const result = await clickhouseTest.connector.executeSQL('SELECT name FROM users WHERE id = 0', {});
      expect(result.resultSets[0]).toMatchObject({ rows: [], rowCount: 0 });
      expect(result.resultSets[0].truncated).toBeUndefined();
    });

    it('should bind positional parameters to {pN:Type} placeholders', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        `SELECT name, {p1:String} AS echoed FROM users
         WHERE id IN {p2:Array(UInt64)} AND age >= {p3:UInt8} ORDER BY id`,
        { readonly: true },
        ["it's a 'quoted'\ttab", [1, 2, 3], 30]
      );
      expect(result.resultSets[0].rows.map((row) => ({ ...row }))).toEqual([
        { name: 'John Doe', echoed: "it's a 'quoted'\ttab" },
        { name: 'Bob Johnson', echoed: "it's a 'quoted'\ttab" },
      ]);
    });

    it('should run each statement of a batch as its own request, with no shared session', async () => {
      // SET applies to its own request only, so the limit it sets is gone by the SELECT.
      const result = await clickhouseTest.connector.executeSQL(
        'SET max_result_rows = 1; SELECT name FROM users WHERE id <= 3 ORDER BY id', {}
      );
      expect(result.resultSets).toHaveLength(2);
      expect(result.resultSets[1].rows.map((row) => value(row, 'name'))).toEqual([
        'John Doe', 'Jane Smith', 'Bob Johnson',
      ]);
    });

    it('should reject a statement that picks its own output format', async () => {
      await expect(
        clickhouseTest.connector.executeSQL('SELECT 1 FORMAT CSV', {})
      ).rejects.toThrow(/responded in the CSV format/);
    });

    it('should report a server error with its code and type', async () => {
      await expect(
        clickhouseTest.connector.executeSQL('SELECT * FROM nonexistent_table', {})
      ).rejects.toMatchObject({ code: '60', type: 'UNKNOWN_TABLE' });
    });
  });

  describe('Row cap by reading', () => {
    it('should cap statements a LIMIT could not be spliced into', async () => {
      const describeTable = await clickhouseTest.connector.executeSQL('DESCRIBE TABLE users', { maxRows: 2 });
      expect(describeTable.resultSets[0].rows.map((row) => value(row, 'name'))).toEqual(['id', 'name']);
      expect(describeTable.resultSets[0].truncated).toBe(true);

      const limitBy = await clickhouseTest.connector.executeSQL(
        'SELECT name FROM users WHERE id <= 3 ORDER BY id LIMIT 1 BY id SETTINGS max_threads = 1',
        { maxRows: 2 }
      );
      expect(limitBy.resultSets[0].rows.map((row) => value(row, 'name'))).toEqual(['John Doe', 'Jane Smith']);
      expect(limitBy.resultSets[0].truncated).toBe(true);
    });

    it('should stop reading a result far larger than the cap, and stay usable', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT number FROM system.numbers', { maxRows: 5, readonly: true }
      );
      expect(result.resultSets[0].rows.map((row) => value(row, 'number'))).toEqual([0, 1, 2, 3, 4]);
      expect(result.resultSets[0].truncated).toBe(true);
      // No counters for a statement whose response was abandoned part-way.
      expect(result.messages).toBeUndefined();

      const after = await clickhouseTest.connector.executeSQL('SELECT 1 AS ok', {});
      expect(after.resultSets[0].rows[0]).toMatchObject({ ok: 1 });
    }, 30_000);

    it('should read a response larger than the server buffer in full', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT number FROM numbers(300000)', {}
      );
      expect(result.resultSets[0].rowCount).toBe(300000);
      expect(value(result.resultSets[0].rows[299999], 'number')).toBe(299999);
      // Its summary header was sent before the statement finished.
      expect(result.messages).toBeUndefined();
    });
  });

  describe('Read statistics', () => {
    it('should report the rows and bytes a statement read', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT sum(number) AS total FROM numbers(1000000)', { readonly: true }
      );
      expect(value(result.resultSets[0].rows[0], 'total')).toBe(499999500000);
      expect(result.messages).toHaveLength(1);
      expect(result.messages![0].text).toMatch(/^Read 1000000 rows \(8000000 bytes\)/);
    });

    it('should report each statement of a batch separately', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT sum(number) FROM numbers(1000); SELECT sum(number) FROM numbers(2000)', {}
      );
      expect(result.messages?.map((message) => message.text.replace(/ in .*$/, ''))).toEqual([
        'Statement 1: Read 1000 rows (8000 bytes)',
        'Statement 2: Read 2000 rows (16000 bytes)',
      ]);
    });

    it('should report what an INSERT ... SELECT read and wrote', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        "INSERT INTO orders (id, user_id, total) SELECT number + 100, 3, 1 FROM numbers(5)", {}
      );
      expect(result.resultSets[0].rowCount).toBe(5);
      expect(result.messages![0].text).toMatch(/^Read \d+ rows \(\d+ bytes\), wrote 5 rows \(\d+ bytes\)/);
    });
  });

  describe('Read-only enforcement by the server', () => {
    const readonly = { readonly: true };

    it.each([
      ['DDL', 'CREATE TABLE ro_probe (id UInt8) ENGINE = Memory'],
      ['a mutation', "ALTER TABLE users DELETE WHERE email = 'john@example.com'"],
      ['a lightweight DELETE', "DELETE FROM users WHERE email = 'john@example.com'"],
      ['TRUNCATE', 'TRUNCATE TABLE orders'],
      ['a settings change in the statement', 'SELECT 1 SETTINGS max_threads = 1'],
      ['SET', 'SET max_threads = 1'],
    ])('should reject %s', async (_label, sql) => {
      await expect(clickhouseTest.connector.executeSQL(sql, readonly)).rejects.toMatchObject({
        type: 'READONLY',
      });
    });

    it('should reject table functions that reach outside the server', async () => {
      // Refused for being read-only, before any attempt to reach the URL or file.
      for (const sql of [
        "SELECT * FROM url('http://127.0.0.1:1/x.csv', CSV, 'a String')",
        "SELECT * FROM file('probe.csv', CSV, 'a String')",
        "SELECT * FROM remote('127.0.0.1:1', system.one)",
      ]) {
        await expect(clickhouseTest.connector.executeSQL(sql, readonly)).rejects.toMatchObject({
          type: 'READONLY',
        });
      }
    });

    it('should still allow reads, including SHOW, DESCRIBE, EXISTS and EXPLAIN', async () => {
      const results = await clickhouseTest.connector.executeSQL(
        `SELECT count() AS n FROM users WHERE id <= 3;
         SHOW CREATE TABLE users;
         DESCRIBE TABLE users;
         EXISTS TABLE users;
         EXPLAIN indexes = 1 SELECT * FROM users WHERE id = 1`,
        readonly
      );
      expect(results.resultSets).toHaveLength(5);
      expect(value(results.resultSets[0].rows[0], 'n')).toBe(3);
      expect(String(value(results.resultSets[1].rows[0], 'statement'))).toContain('CREATE TABLE test.users');
      expect(results.resultSets[2].rows.map((row) => value(row, 'name'))).toContain('email');
      expect(value(results.resultSets[3].rows[0], 'result')).toBe(1);
      const plan = results.resultSets[4].rows.map((row) => String(value(row, 'explain'))).join('\n');
      expect(plan).toContain('ReadFromMergeTree');
      expect(plan).toContain('PrimaryKey');
    });

    it('should leave the seed rows in place', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT count() AS n FROM users WHERE id <= 3', {}
      );
      expect(value(result.resultSets[0].rows[0], 'n')).toBe(3);
    });
  });

  describe('A user whose own profile is read-only', () => {
    it('should work for a readonly = 1 user, who may not change any setting', async () => {
      const connector = clickhouseTest.createConnector();
      try {
        await connector.connect(clickhouseTest.dsnFor('ro1', 'ro1pass'));
        const result = await connector.executeSQL(
          'SELECT name FROM users WHERE id <= 3 ORDER BY id', { readonly: true, maxRows: 2 }
        );
        expect(result.resultSets[0].rows.map((row) => value(row, 'name'))).toEqual(['John Doe', 'Jane Smith']);
        expect(result.resultSets[0].truncated).toBe(true);
        expect(await connector.getTables()).toContain('users');

        await expect(
          connector.executeSQL("INSERT INTO users (name, email) VALUES ('x', 'x@example.com')", {})
        ).rejects.toMatchObject({ type: 'READONLY' });
      } finally {
        await connector.disconnect();
      }
    });

    it('should refuse [sources.session] for a readonly = 1 user instead of dropping it', async () => {
      const connector = clickhouseTest.createConnector();
      await expect(
        connector.connect(clickhouseTest.dsnFor('ro1', 'ro1pass'), undefined, {
          sessionSettings: { max_rows_to_read: 1000 },
        })
      ).rejects.toThrow(/restricted to readonly = 1 and cannot change settings/);
    });

    it('should work for a readonly = 2 user, sending settings but not readonly', async () => {
      const connector = clickhouseTest.createConnector();
      try {
        await connector.connect(clickhouseTest.dsnFor('ro2', 'ro2pass'), undefined, {
          sessionSettings: { max_rows_to_read: 100 },
        });
        const result = await connector.executeSQL(
          'SELECT name FROM users WHERE id <= 3 ORDER BY id', { readonly: true }
        );
        expect(result.resultSets[0].rowCount).toBe(3);
        // The session setting reached the server.
        await expect(
          connector.executeSQL('SELECT number FROM numbers(100000)', { readonly: true })
        ).rejects.toMatchObject({ type: 'TOO_MANY_ROWS' });
        await expect(
          connector.executeSQL("INSERT INTO users (name, email) VALUES ('x', 'x@example.com')", {})
        ).rejects.toMatchObject({ type: 'READONLY' });
      } finally {
        await connector.disconnect();
      }
    });
  });

  describe('Timeouts and scan budgets', () => {
    it('should have the server stop a query that runs past query_timeout', async () => {
      await clickhouseTest.withConnector({ queryTimeoutSeconds: 1 }, async (connector) => {
        const started = Date.now();
        await expect(
          connector.executeSQL('SELECT count() FROM system.numbers WHERE number % 7 = 1', { readonly: true })
        ).rejects.toMatchObject({ type: 'TIMEOUT_EXCEEDED' });
        // Stopped by the server near the limit, well before the client-side deadline.
        expect(Date.now() - started).toBeLessThan(5000);

        const after = await connector.executeSQL('SELECT 1 AS ok', { readonly: true });
        expect(after.resultSets[0].rows[0]).toMatchObject({ ok: 1 });
      });
    }, 30_000);

    it('should apply [sources.session] scan budgets to every statement, read-only or not', async () => {
      await clickhouseTest.withConnector(
        { sessionSettings: { max_rows_to_read: 1000, read_overflow_mode: 'throw' } },
        async (connector) => {
          for (const options of [{ readonly: true }, {}]) {
            await expect(
              connector.executeSQL('SELECT sum(number) FROM numbers(1000000)', options)
            ).rejects.toMatchObject({ type: 'TOO_MANY_ROWS' });
          }
          // A read-only statement cannot lift the budget for itself.
          await expect(
            connector.executeSQL(
              'SELECT sum(number) FROM numbers(1000000) SETTINGS max_rows_to_read = 0',
              { readonly: true }
            )
          ).rejects.toMatchObject({ type: 'READONLY' });

          const small = await connector.executeSQL('SELECT sum(number) AS total FROM numbers(10)', { readonly: true });
          expect(value(small.resultSets[0].rows[0], 'total')).toBe(45);
        }
      );
    });

    it('should fail the connection when the server rejects a session setting', async () => {
      const connector = clickhouseTest.createConnector();
      await expect(
        connector.connect(clickhouseTest.connectionString, undefined, {
          sessionSettings: { no_such_setting_dbhub: 1 },
        })
      ).rejects.toMatchObject({ type: 'UNKNOWN_SETTING' });
    });
  });

  describe('Connection failures', () => {
    it('should report a wrong password as an authentication failure', async () => {
      const connector = clickhouseTest.createConnector();
      const failure = await connector
        .connect(clickhouseTest.dsnFor(APP_USER, 'wrong-password'))
        .then(() => null, (error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(classifyConnectionError(failure, 'clickhouse', 'ch')?.code).toBe('AUTH_FAILED');
    });

    it('should report an unknown database with the server error', async () => {
      const connector = clickhouseTest.createConnector();
      await expect(
        connector.connect(clickhouseTest.dsnFor(APP_USER, APP_PASSWORD, 'no_such_db'))
      ).rejects.toMatchObject({ type: 'UNKNOWN_DATABASE' });
    });
  });

  describe('ClickHouse catalog', () => {
    it('should default to the DSN database and leave system databases out', async () => {
      expect(await clickhouseTest.connector.getDefaultSchema!()).toBe(APP_DATABASE);
      const schemas = await clickhouseTest.connector.getSchemas();
      expect(schemas).toEqual(expect.arrayContaining([APP_DATABASE, 'test_schema', 'default']));
      expect(schemas).not.toContain('system');
      expect(schemas).not.toContain('INFORMATION_SCHEMA');
      expect(schemas).not.toContain('information_schema');
    });

    it('should list views and materialized views as views, and their target table as a table', async () => {
      const views = await clickhouseTest.connector.getViews();
      expect(views).toEqual(expect.arrayContaining(['active_users', 'events_per_day_mv']));
      const tables = await clickhouseTest.connector.getTables();
      expect(tables).toContain('events_per_day');
      expect(tables).not.toContain('events_per_day_mv');
    });

    it('should describe columns with nullability from the type and computed defaults', async () => {
      const columns = await clickhouseTest.connector.getTableSchema('events');
      const byName = Object.fromEntries(columns.map((column) => [column.column_name, column]));

      expect(columns.map((column) => column.column_name)).toEqual([
        'tenant_id', 'ts', 'id', 'url', 'payload', 'kind', 'day', 'host', 'version',
      ]);
      expect(byName.tenant_id).toMatchObject({ data_type: 'UInt32', is_nullable: 'NO', column_default: null });
      expect(byName.payload).toMatchObject({ data_type: 'Nullable(String)', is_nullable: 'YES' });
      expect(byName.kind).toMatchObject({
        data_type: 'LowCardinality(Nullable(String))',
        is_nullable: 'YES',
        column_default: "'view'",
      });
      expect(byName.day.column_default).toBe('MATERIALIZED toDate(ts)');
      expect(byName.host.column_default).toBe('ALIAS domain(url)');
    });

    it('should report the primary key, the longer sorting key and skipping indexes, none unique', async () => {
      expect(await clickhouseTest.connector.getTableIndexes('events')).toEqual([
        { index_name: 'PRIMARY KEY', column_names: ['tenant_id', 'toDate(ts)'], is_unique: false, is_primary: true },
        { index_name: 'ORDER BY', column_names: ['tenant_id', 'toDate(ts)', 'id'], is_unique: false, is_primary: false },
        { index_name: 'idx_url', column_names: ['lower(url)'], is_unique: false, is_primary: false },
      ]);
    });

    it('should report no indexes for a view and for an unknown table', async () => {
      expect(await clickhouseTest.connector.getTableIndexes('active_users')).toEqual([]);
      expect(await clickhouseTest.connector.getTableIndexes('nonexistent_table')).toEqual([]);
    });

    it('should read exact row counts from table metadata, and none for a view', async () => {
      expect(await clickhouseTest.connector.getTableRowCount!('events')).toBe(3);
      expect(await clickhouseTest.connector.getTableRowCount!('products', 'test_schema')).toBe(2);
      expect(await clickhouseTest.connector.getTableRowCount!('active_users')).toBeNull();
      expect(await clickhouseTest.connector.getTableRowCount!('nonexistent_table')).toBeNull();
    });

    it('should list user-defined functions as functions, with their parameters and definition', async () => {
      expect(await clickhouseTest.connector.getStoredProcedures(undefined, 'procedure')).toEqual([]);
      expect(await clickhouseTest.connector.getStoredProcedures(undefined, 'function')).toEqual(
        expect.arrayContaining(['dbhub_add', 'dbhub_user_label'])
      );

      const detail = await clickhouseTest.connector.getStoredProcedureDetail('dbhub_add');
      expect(detail).toMatchObject({
        procedure_name: 'dbhub_add',
        procedure_type: 'function',
        language: 'sql',
        parameter_list: 'a, b',
      });
      expect(detail.definition).toContain('CREATE FUNCTION dbhub_add');

      await expect(
        clickhouseTest.connector.getStoredProcedureDetail('no_such_function')
      ).rejects.toThrow("Function 'no_such_function' not found");
    });

    it('should not offer health_check metrics', () => {
      expect(clickhouseTest.connector.getHealthCheck).toBeUndefined();
    });
  });

  describe('Analytics behaviour an agent has to see', () => {
    it('should show the versions a ReplacingMergeTree holds until FINAL collapses them', async () => {
      // A second version of event 1: what a CDC pipeline writes for an update.
      await clickhouseTest.connector.executeSQL(
        `INSERT INTO events (tenant_id, ts, id, url, payload, version)
         VALUES (1, '2026-01-01 10:00:00', 1, 'https://example.com/a', 'updated', 2)`, {}
      );

      const result = await clickhouseTest.connector.executeSQL(
        `SELECT count() AS versions FROM events WHERE tenant_id = 1 AND id = 1;
         SELECT count() AS versions FROM events FINAL WHERE tenant_id = 1 AND id = 1;
         SELECT payload FROM events FINAL WHERE tenant_id = 1 AND id = 1`,
        { readonly: true }
      );
      expect(value(result.resultSets[0].rows[0], 'versions')).toBe(2);
      expect(value(result.resultSets[1].rows[0], 'versions')).toBe(1);
      expect(value(result.resultSets[2].rows[0], 'payload')).toBe('updated');
    });

    it('should read what a materialized view wrote to its target table', async () => {
      const result = await clickhouseTest.connector.executeSQL(
        'SELECT tenant_id, sum(events) AS events FROM events_per_day GROUP BY tenant_id ORDER BY tenant_id',
        { readonly: true }
      );
      expect(result.resultSets[0].rows.map((row) => ({ ...row }))).toEqual([
        { tenant_id: 1, events: 3 },
        { tenant_id: 2, events: 1 },
      ]);
    });
  });
});
