import { describe, it, expect } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PostgresConnector } from '../postgres/index.js';
import { IntegrationTestBase, type DatabaseTestConfig } from './shared/integration-test-base.js';
import { settle, waitFor } from './shared/query-timeout-helpers.js';
import { CLIENT_QUERY_TIMEOUT_GRACE_MS } from '../../utils/query-timeout.js';
import type { Connector } from '../interface.js';

class PostgreSQLIntegrationTest extends IntegrationTestBase<StartedPostgreSqlContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      expectedSchemas: ['public', 'test_schema'],
      expectedTables: ['users', 'orders'],
      expectedTestSchemaTable: 'products',
      testSchema: 'test_schema',
      supportsStoredProcedures: true,
      expectedStoredProcedures: ['get_user_count', 'calculate_total_age'],
      supportsComments: true,
      readonlyWriteError: /read-only transaction/i,
    };
    super(config);
  }

  createContainer(): Promise<StartedPostgreSqlContainer> {
    return new PostgreSqlContainer('postgres:15-alpine')
      .withDatabase('testdb')
      .withUsername('testuser')
      .withPassword('testpass')
      .start();
  }

  createConnector(): Connector {
    return new PostgresConnector();
  }

  protected async expectSessionEncryption(connector: Connector, encrypted: boolean): Promise<void> {
    const result = await connector.executeSQL('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()', {});
    expect(result.resultSets[0].rows).toEqual([{ ssl: encrypted }]);
  }

  async setupTestData(connector: Connector): Promise<void> {
    // Create test schema
    await connector.executeSQL('CREATE SCHEMA IF NOT EXISTS test_schema', {});
    
    // Create users table
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        age INTEGER
      )
    `, {});

    // Create orders table
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        total DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, {});

    // Create products table in test_schema
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS test_schema.products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10,2)
      )
    `, {});

    // Add table and column comments
    await connector.executeSQL(`COMMENT ON TABLE users IS 'Application users'`, {});
    await connector.executeSQL(`COMMENT ON COLUMN users.name IS 'Full name of the user'`, {});
    await connector.executeSQL(`COMMENT ON COLUMN users.email IS 'Unique email address'`, {});

    // Insert test data
    await connector.executeSQL(`
      INSERT INTO users (name, email, age) VALUES
      ('John Doe', 'john@example.com', 30),
      ('Jane Smith', 'jane@example.com', 25),
      ('Bob Johnson', 'bob@example.com', 35)
      ON CONFLICT (email) DO NOTHING
    `, {});

    await connector.executeSQL(`
      INSERT INTO orders (user_id, total) VALUES 
      (1, 99.99),
      (1, 149.50),
      (2, 75.25)
      ON CONFLICT DO NOTHING
    `, {});

    await connector.executeSQL(`
      INSERT INTO test_schema.products (name, price) VALUES
      ('Widget A', 19.99),
      ('Widget B', 29.99)
      ON CONFLICT DO NOTHING
    `, {});

    // Create schema with special name (spaces, uppercase) for search_path quoting tests
    await connector.executeSQL('CREATE SCHEMA IF NOT EXISTS "My Schema"', {});
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS "My Schema".items (
        id SERIAL PRIMARY KEY,
        label VARCHAR(100) NOT NULL
      )
    `, {});
    await connector.executeSQL(`
      INSERT INTO "My Schema".items (label) VALUES ('Item A'), ('Item B')
      ON CONFLICT DO NOTHING
    `, {});

    // Create a view with a comment (for view comment test)
    await connector.executeSQL(`
      CREATE OR REPLACE VIEW active_users AS SELECT id, name, email FROM users WHERE age >= 25
    `, {});
    await connector.executeSQL(`COMMENT ON VIEW active_users IS 'Users aged 25 or older'`, {});

    // Create a foreign table (for foreign table discovery tests, #418). A
    // handler-less FDW is enough: the catalog entries exist and can be
    // enumerated/described, the table just can't be scanned.
    await connector.executeSQL('CREATE FOREIGN DATA WRAPPER dummy_fdw', {});
    await connector.executeSQL('CREATE SERVER IF NOT EXISTS dummy_server FOREIGN DATA WRAPPER dummy_fdw', {});
    await connector.executeSQL(`
      CREATE FOREIGN TABLE IF NOT EXISTS remote_users (
        id INTEGER,
        name VARCHAR(100),
        email VARCHAR(100),
        age INTEGER
      ) SERVER dummy_server
    `, {});
    await connector.executeSQL(`COMMENT ON FOREIGN TABLE remote_users IS 'Users on a remote server'`, {});

    // Create test stored procedures using SQL language to avoid dollar quoting
    await connector.executeSQL(`
      CREATE OR REPLACE FUNCTION get_user_count()
      RETURNS INTEGER
      LANGUAGE SQL
      AS 'SELECT COUNT(*)::INTEGER FROM users'
    `, {});

    await connector.executeSQL(`
      CREATE OR REPLACE FUNCTION calculate_total_age()
      RETURNS INTEGER
      LANGUAGE SQL  
      AS 'SELECT COALESCE(SUM(age), 0)::INTEGER FROM users WHERE age IS NOT NULL'
    `, {});
  }
}


const postgresTest = new PostgreSQLIntegrationTest();

describe('PostgreSQL Connector Integration Tests', () => {
  postgresTest.registerLifecycle();

  postgresTest.createCommonTests();
  postgresTest.createSSLTests();

  describe('index metadata', () => {
    it.each([
      ['composite', 'PRIMARY KEY (c, a, b)', '', ['c', 'a', 'b'], undefined, true],
      ['covering', 'PRIMARY KEY (c, a) INCLUDE (b)', '', ['c', 'a'], ['b'], true],
      ['expression', '', 'CREATE INDEX expression_idx ON index_metadata_expression ((a + b), c) INCLUDE (b, a)', ['(a + b)', 'c'], ['b', 'a'], false],
    ] as const)('preserves key order and included columns: %s', async (name, constraint, indexSql, keys, included, primary) => {
      const table = `index_metadata_${name}`;
      await postgresTest.connector.executeSQL(
        `CREATE TABLE ${table} (a int, b int, c int${constraint ? `, ${constraint}` : ''})`, {}
      );
      try {
        if (indexSql) await postgresTest.connector.executeSQL(indexSql, {});
        const indexes = await postgresTest.connector.getTableIndexes(table, 'public');
        expect(indexes).toEqual([{
          index_name: primary ? `${table}_pkey` : 'expression_idx',
          column_names: [...keys],
          ...(included ? { included_columns: [...included] } : {}),
          is_unique: primary,
          is_primary: primary,
        }]);
      } finally {
        await postgresTest.connector.executeSQL(`DROP TABLE ${table}`, {});
      }
    });
  });

  describe('query_timeout', () => {
    /** Statements carrying `probe` that the server is running, as `observer` sees them. */
    const runningProbeCount = async (observer: Connector, probe: string): Promise<number> => {
      const result = await observer.executeSQL(
        `SELECT count(*)::int AS count
         FROM pg_stat_activity
         WHERE state = 'active'
           AND query LIKE '%${probe}%'
           AND query NOT LIKE '%pg_stat_activity%'`,
        {}
      );
      return result.resultSets[0].rows[0].count;
    };

    it('should cancel a timed-out query on the PostgreSQL server', async () => {
      const probe = 'dbhub_query_timeout_probe';
      await postgresTest.withConnector({ queryTimeoutSeconds: 1 }, (timedConnector) =>
        postgresTest.withConnector(undefined, async (observer) => {
          const query = timedConnector.executeSQL(
            `SELECT pg_sleep(10), '${probe}'`,
            { readonly: true }
          );
          const settled = query.then(
            () => null,
            (error) => error as NodeJS.ErrnoException
          );

          expect(await waitFor(async () => (await runningProbeCount(observer, probe)) === 1, 5_000)).toBe(true);

          const error = await settled;
          expect(error).toBeInstanceOf(Error);
          expect(error?.code).toBe('57014');
          expect(await waitFor(async () => (await runningProbeCount(observer, probe)) === 0, 2_000)).toBe(true);

          const after = await timedConnector.executeSQL('SELECT 1 AS ok', { readonly: true });
          expect(after.resultSets[0].rows[0].ok).toBe(1);
        })
      );
    }, 20_000);

    it('should fall back to the client-side timeout and cancel the statement when the server limit is cleared', async () => {
      const probe = 'dbhub_client_timeout_probe';
      // A pool of one: the cancel has to reuse the slot of the client it replaces.
      await postgresTest.withConnector({ queryTimeoutSeconds: 1, poolMaxConnections: 1 }, (timedConnector) =>
        postgresTest.withConnector(undefined, async (observer) => {
          // The batch clears statement_timeout first, so only the client-side
          // fallback is left to bound the SELECT.
          const result = await settle(
            timedConnector.executeSQL(
              `SET statement_timeout = 0; SELECT pg_sleep(30), '${probe}'`,
              {}
            )
          );

          expect(result.error?.message).toBe('Query read timeout');
          expect(result.elapsedMs).toBeGreaterThanOrEqual(1000 + CLIENT_QUERY_TIMEOUT_GRACE_MS - 100);
          // Not twice the deadline: the ROLLBACK is skipped rather than queued
          // behind the abandoned statement.
          expect(result.elapsedMs).toBeLessThan(10_000);
          expect(await waitFor(async () => (await runningProbeCount(observer, probe)) === 0, 2_000)).toBe(true);

          // The abandoned client was discarded; a fresh one carries the limit again.
          const after = await timedConnector.executeSQL(
            "SELECT current_setting('statement_timeout') AS statement_timeout",
            { readonly: true }
          );
          expect(after.resultSets[0].rows[0].statement_timeout).toBe('1s');
        })
      );
    }, 30_000);
  });

  describe('PostgreSQL-specific Features', () => {
    it('should execute multiple statements with transaction support', async () => {
      const result = await postgresTest.connector.executeSQL(`
        INSERT INTO users (name, email, age) VALUES ('Multi User 1', 'multi1@example.com', 30);
        INSERT INTO users (name, email, age) VALUES ('Multi User 2', 'multi2@example.com', 35);
        SELECT COUNT(*) as total FROM users WHERE email LIKE 'multi%';
        SELECT name FROM users WHERE email LIKE 'multi%' ORDER BY name;
      `, { maxRows: 1 });

      expect(result.resultSets).toHaveLength(4);
      expect(result.resultSets[0]).toEqual({
        sql: "INSERT INTO users (name, email, age) VALUES ('Multi User 1', 'multi1@example.com', 30)",
        rows: [],
        rowCount: 1,
      });
      expect(result.resultSets[1]).toEqual({
        sql: "INSERT INTO users (name, email, age) VALUES ('Multi User 2', 'multi2@example.com', 35)",
        rows: [],
        rowCount: 1,
      });
      expect(result.resultSets[2].rows).toHaveLength(1);
      expect(result.resultSets[2].rows[0].total).toBe('2');
      // maxRows leaves the writes alone and caps a SELECT that shares their
      // batch, which still reports the statement as it was written
      expect(result.resultSets[3]).toMatchObject({
        sql: "SELECT name FROM users WHERE email LIKE 'multi%' ORDER BY name",
        rows: [{ name: 'Multi User 1' }],
        truncated: true,
      });
    });

    it('should roll the whole batch back when one of its statements fails', async () => {
      await expect(
        postgresTest.connector.executeSQL(`
          BEGIN;
          INSERT INTO users (name, email, age) VALUES ('Transaction Test', 'trans@example.com', 40);
          INSERT INTO users (name, email, age) VALUES ('Transaction Test', 'trans@example.com', 40); -- This should fail due to unique constraint
          COMMIT;
        `, {})
      ).rejects.toThrow();
      
      // Verify rollback worked
      const result = await postgresTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email = 'trans@example.com'",
        {}
      );
      expect(result.resultSets[0].rows[0].count).toBe('0');
    });

    it('should return the rows of a write with a RETURNING clause', async () => {
      const result = await postgresTest.connector.executeSQL(
        "INSERT INTO users (name, email, age) VALUES ('Returning Test', 'returning@example.com', 40) RETURNING id, name",
        {}
      );
      
      expect(result.resultSets[0].rows).toHaveLength(1);
      expect(result.resultSets[0].rows[0].id).toBeDefined();
      expect(result.resultSets[0].rows[0].name).toBe('Returning Test');
    });

    it('should return date/timestamp values verbatim, not shifted by the host timezone', async () => {
      // Regression test for https://github.com/bytebase/dbhub/issues/416
      const result = await postgresTest.connector.executeSQL(
        `SELECT
           '2026-01-01 12:00:00.123456'::timestamp AS naive,
           '2026-01-01 12:00:00+00'::timestamptz AS aware,
           '2026-01-01'::date AS day,
           ARRAY['2026-01-01 12:00:00'::timestamp] AS naive_arr`,
        {}
      );

      const row = result.resultSets[0].rows[0];
      expect(row.naive).toBe('2026-01-01 12:00:00.123456');
      expect(row.day).toBe('2026-01-01');
      expect(typeof row.aware).toBe('string');
      expect(row.aware).toMatch(/^2026-01-01 /);
      expect(row.naive_arr).toBe('{"2026-01-01 12:00:00"}');
    });

    it('should return comment for views via getTableComment', async () => {
      const comment = await postgresTest.connector.getTableComment!('active_users');
      expect(comment).toBe('Users aged 25 or older');
    });

    it('should list foreign tables as tables, not views', async () => {
      const tables = await postgresTest.connector.getTables();
      expect(tables).toContain('remote_users');

      const views = await postgresTest.connector.getViews();
      expect(views).not.toContain('remote_users');
    });

    it('should describe foreign tables like regular tables', async () => {
      const columns = await postgresTest.connector.getTableSchema('remote_users');
      expect(columns.map((c) => c.column_name)).toEqual(['id', 'name', 'email', 'age']);

      const comment = await postgresTest.connector.getTableComment!('remote_users');
      expect(comment).toBe('Users on a remote server');

      // Foreign tables cannot have indexes; this must return empty rather than throw.
      const indexes = await postgresTest.connector.getTableIndexes('remote_users');
      expect(indexes).toEqual([]);
    });

    it('should report connection pool state and buffer cache hit ratio via getHealthCheck', async () => {
      const health = await postgresTest.connector.getHealthCheck!();

      expect(health.connections).toBeDefined();
      expect(health.connections!.total).toBeGreaterThanOrEqual(1);
      expect(health.connections!.maxConnections).toBeGreaterThan(0);
      expect(health.connections!.idleInTransaction).toBeGreaterThanOrEqual(0);

      expect(health.bufferCache).toBeDefined();
      expect(health.bufferCache!.blocksHit + health.bufferCache!.blocksRead).toBeGreaterThan(0);
      if (health.bufferCache!.hitRatioPct !== null) {
        expect(health.bufferCache!.hitRatioPct).toBeGreaterThanOrEqual(0);
        expect(health.bufferCache!.hitRatioPct).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('SDK-Level Readonly Mode Tests', () => {
    it('should set default_transaction_read_only on the connection: reads work, writes and DDL are rejected', async () => {
      // Connection-level readonly; no execution here passes options.readonly.
      await postgresTest.withConnector({ readonly: true }, async (connector) => {
        const setting = await connector.executeSQL('SHOW default_transaction_read_only', {});
        expect(setting.resultSets[0].rows).toEqual([{ default_transaction_read_only: 'on' }]);

        const read = await connector.executeSQL('SELECT * FROM users ORDER BY id LIMIT 1', {});
        expect(read.resultSets[0].rows).toHaveLength(1);
        expect(read.resultSets[0].rows[0].name).toBe('John Doe');

        await expect(
          connector.executeSQL("INSERT INTO users (name, email) VALUES ('fail', 'fail@test.com')", {})
        ).rejects.toThrow(/read-only/);
        await expect(
          connector.executeSQL('CREATE TABLE should_fail (id INTEGER)', {})
        ).rejects.toThrow(/read-only/);
      });
    });
  });

  describe('Per-tool readonly engine backstop: function-based writes', () => {
    // Read-only is enforced per execution by running inside a READ ONLY
    // transaction. This catches function-based writes that the
    // leading-keyword classifier passes (e.g. SELECT setval()).
    it('should block a sequence write via SELECT setval() when options.readonly is set', async () => {
      await postgresTest.withConnector(undefined, async (connector) => {
        // SELECT setval(...) passes the read-only keyword classifier but writes a
        // sequence; the READ ONLY transaction must reject it at the engine.
        await expect(
          connector.executeSQL(
            "SELECT setval(pg_get_serial_sequence('users','id'), 1, true)",
            { readonly: true }
          )
        ).rejects.toThrow(/read-only transaction/i);
      });
    });
  });

  describe('Search Path Configuration Tests', () => {
    it('should use first schema in search_path as default for discovery', async () => {
      await postgresTest.withConnector({ searchPath: 'test_schema,public' }, async (connector) => {
        // Session search_path should be set
        const result = await connector.executeSQL('SHOW search_path', {});
        expect(result.resultSets[0].rows[0].search_path).toContain('test_schema');

        // Discovery defaults to test_schema (first in search_path)
        const tables = await connector.getTables();
        expect(tables).toContain('products');
        expect(tables).not.toContain('users');

        // Explicit schema override still works
        const publicTables = await connector.getTables('public');
        expect(publicTables).toContain('users');

        // SQL resolves unqualified names via search_path
        const sqlResult = await connector.executeSQL('SELECT * FROM products', {});
        expect(sqlResult.resultSets[0].rows.length).toBeGreaterThan(0);
      });
    });

    it('should handle schema names with spaces and special characters', async () => {
      await postgresTest.withConnector({ searchPath: 'My Schema,public' }, async (connector) => {
        // Discovery defaults to "My Schema"
        const tables = await connector.getTables();
        expect(tables).toContain('items');
        expect(tables).not.toContain('users');

        // SQL resolves unqualified names via quoted search_path
        const result = await connector.executeSQL('SELECT * FROM items', {});
        expect(result.resultSets[0].rows.length).toBeGreaterThan(0);
        expect(result.resultSets[0].rows[0]).toHaveProperty('label');
      });
    });
  });

  describe('[sources.session] settings', () => {
    it('should apply each setting to every new connection as its default', async () => {
      await postgresTest.withConnector(
        {
          searchPath: 'test_schema,public',
          sessionSettings: {
            lock_timeout: '5s',
            idle_in_transaction_session_timeout: 60000,
            application_name: 'dbhub agent',
            'dbhub.note': 'a b\\c',
          },
        },
        async (connector) => {
          const show =
            "SELECT current_setting('lock_timeout') AS lock_timeout, " +
            "current_setting('idle_in_transaction_session_timeout') AS idle, " +
            "current_setting('application_name') AS app, " +
            "current_setting('dbhub.note') AS note, " +
            "current_setting('search_path') AS search_path";
          // Concurrent calls check out separate pool connections.
          const results = await Promise.all(
            [0, 1, 2].map(() => connector.executeSQL(show, { readonly: true }))
          );
          for (const result of results) {
            expect(result.resultSets[0].rows[0]).toMatchObject({
              lock_timeout: '5s',
              idle: '1min',
              app: 'dbhub agent',
              note: 'a b\\c',
            });
            expect(result.resultSets[0].rows[0].search_path).toContain('test_schema');
          }
        }
      );
    });

    it('should block writes on a connection whose default is read-only', async () => {
      await postgresTest.withConnector(
        { sessionSettings: { default_transaction_read_only: true } },
        async (connector) => {
          await expect(
            connector.executeSQL('CREATE TABLE dbhub_session_ro (id int)', {})
          ).rejects.toThrow(/read-only transaction/);
        }
      );
    });

    it('should fail to connect when the server rejects a setting', async () => {
      await expect(
        new PostgresConnector().connect(postgresTest.connectionString, undefined, {
          sessionSettings: { lock_timeout: 'soon' },
        })
      ).rejects.toThrow(/lock_timeout/);
    });

    it('should keep connection-level readonly in force over a conflicting session setting', async () => {
      // The server applies startup options in order, so the enforced option
      // must come after the session table to win.
      await postgresTest.withConnector(
        { readonly: true, sessionSettings: { default_transaction_read_only: false } },
        async (connector) => {
          const show = await connector.executeSQL('SHOW default_transaction_read_only', {});
          expect(show.resultSets[0].rows[0].default_transaction_read_only).toBe('on');
          await expect(
            connector.executeSQL('CREATE TABLE dbhub_session_ro_conflict (id int)', {})
          ).rejects.toThrow(/read-only transaction/);
        }
      );
    });
  });
});
