import { describe, it, expect } from 'vitest';
import { IntegrationTestBase, type TestContainer } from './integration-test-base.js';
import { settle, waitFor } from './query-timeout-helpers.js';
import { CLIENT_QUERY_TIMEOUT_GRACE_MS } from '../../../utils/query-timeout.js';
import type { Connector } from '../../interface.js';

/** Where the MySQL and MariaDB suites differ in what the shared tests expect. */
export interface MySQLFamilyTraits {
  /** Passed to createSSLTests: how `sslmode=require` fails on a container without TLS. */
  ssl?: { requireFailure?: RegExp; requireDeadlineMs?: number };
  /** A utf8mb4 collation the server has that is not the driver's default for the charset. */
  collation: string;
  /** How `query_timeout` shows up on this server and in this driver. */
  queryTimeout: {
    /** The session variable holding the server-side limit. */
    sessionVariable: string;
    /** Its value for a one-second limit (MySQL counts milliseconds, MariaDB seconds). */
    oneSecond: number;
    /** The error code of the client-side fallback. */
    clientTimeoutCode: string;
    /**
     * Run the client-side fallback on a pool of one. Only where the connector
     * has `pool_max_connections` (MySQL): its kill has to reuse the slot of
     * the connection it replaces. MariaDB has no such option (the TOML loader
     * rejects it there) and its driver kills over a connection of its own.
     */
    poolOfOne?: boolean;
  };
}

/**
 * What the MySQL and MariaDB integration suites have in common, which is
 * nearly everything: the connectors share a base class (see
 * mysql-family-connector.ts), the servers the same SQL and catalog. Each
 * suite adds its container, its connector, and the tests for what its driver
 * does differently.
 */
export abstract class MySQLFamilyIntegrationTest<
  TContainer extends TestContainer,
> extends IntegrationTestBase<TContainer> {
  constructor() {
    super({
      expectedSchemas: ['testdb'],
      expectedTables: ['users', 'orders', 'products'],
      supportsStoredProcedures: false, // Disabled due to container privilege restrictions
      supportsComments: true,
      beginTransaction: 'START TRANSACTION',
      readonlyWriteError: /read only|read-only/i,
    });
  }

  protected async expectSessionEncryption(connector: Connector, encrypted: boolean): Promise<void> {
    // The cipher is empty when the session is not encrypted.
    const result = await connector.executeSQL("SHOW SESSION STATUS LIKE 'Ssl_cipher'", {});
    expect(result.resultSets[0].rows).toEqual([
      { Variable_name: 'Ssl_cipher', Value: encrypted ? expect.stringMatching(/./) : '' },
    ]);
  }

  async setupTestData(connector: Connector): Promise<void> {
    // Create users table
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        age INT
      )
    `, {});

    // Create orders table
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        total DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `, {});

    // Create products table in main database
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10,2)
      )
    `, {});

    // Add table and column comments
    await connector.executeSQL(`ALTER TABLE users COMMENT = 'Application users'`, {});
    await connector.executeSQL(`ALTER TABLE users MODIFY COLUMN name VARCHAR(100) NOT NULL COMMENT 'Full name of the user'`, {});
    await connector.executeSQL(`ALTER TABLE users MODIFY COLUMN email VARCHAR(100) UNIQUE NOT NULL COMMENT 'Unique email address'`, {});

    // Insert test data
    await connector.executeSQL(`
      INSERT IGNORE INTO users (name, email, age) VALUES
      ('John Doe', 'john@example.com', 30),
      ('Jane Smith', 'jane@example.com', 25),
      ('Bob Johnson', 'bob@example.com', 35)
    `, {});

    await connector.executeSQL(`
      INSERT IGNORE INTO orders (user_id, total) VALUES
      (1, 99.99),
      (1, 149.50),
      (2, 75.25)
    `, {});

    await connector.executeSQL(`
      INSERT IGNORE INTO products (name, price) VALUES
      ('Widget A', 19.99),
      ('Widget B', 29.99)
    `, {});

    // Note: Stored procedures/functions are skipped in tests due to container privilege restrictions
  }

  /** The common connector tests plus everything MySQL and MariaDB share. */
  createFamilyTests(traits: MySQLFamilyTraits): void {
    this.createCommonTests();
    this.createSSLTests(traits.ssl);

    describe('MySQL-family Features', () => {
      it('should exclude server-level system databases from getSchemas()', async () => {
        const schemas = await this.connector.getSchemas();
        expect(schemas).toContain('testdb');
        expect(schemas).not.toContain('information_schema');
        expect(schemas).not.toContain('performance_schema');
        expect(schemas).not.toContain('mysql');
        expect(schemas).not.toContain('sys');
      });

      it('should report the DSN-configured database as the default schema', async () => {
        expect(await this.connector.getDefaultSchema!()).toBe('testdb');
      });

      it('should report connection pool state and buffer cache hit ratio via getHealthCheck', async () => {
        const health = await this.connector.getHealthCheck!();

        expect(health.connections).toBeDefined();
        // Without the PROCESS privilege, PROCESSLIST visibility can be
        // restricted to the querying connection itself (excluded here via
        // `ID <> CONNECTION_ID()`), so total may legitimately be 0.
        expect(health.connections!.total).toBeGreaterThanOrEqual(0);
        expect(health.connections!.maxConnections).toBeGreaterThan(0);
        expect(health.connections!.idleInTransaction).toBeGreaterThanOrEqual(0);
        expect(health.connections!.idleInTransactionAborted).toBeUndefined();

        expect(health.bufferCache).toBeDefined();
        expect(health.bufferCache!.blocksHit + health.bufferCache!.blocksRead).toBeGreaterThan(0);
        if (health.bufferCache!.hitRatioPct !== null) {
          expect(health.bufferCache!.hitRatioPct).toBeGreaterThanOrEqual(0);
          expect(health.bufferCache!.hitRatioPct).toBeLessThanOrEqual(100);
        }
      });

      it('should run a batch on one session and return one result set per statement', async () => {
        // INSERT and SELECT LAST_INSERT_ID() in a single call: the id is only
        // visible on the connection that inserted.
        const result = await this.connector.executeSQL(
          "INSERT INTO users (name, email, age) VALUES ('Auto Inc Test', 'autoinc@example.com', 40); SELECT LAST_INSERT_ID() as last_id",
          {}
        );

        // One resultSet per statement, in source order: INSERT then SELECT.
        expect(result.resultSets).toHaveLength(2);
        expect(result.resultSets[0].rows).toHaveLength(0);
        expect(result.resultSets[1].rows).toHaveLength(1);
        expect(Number(result.resultSets[1].rows[0].last_id)).toBeGreaterThan(0);
      });
    });

    describe('charset / collation configuration', () => {
      // The collation is what reaches the driver: it implies its character
      // set, with or without a charset configured beside it.
      it.each([
        ['on its own', {}],
        ['together with a charset', { charset: 'utf8mb4' }],
      ])('should set the connection collation from a collation configured %s', async (_label, charset) => {
        await this.withConnector({ ...charset, collation: traits.collation }, async (connector) => {
          const result = await connector.executeSQL(
            'SELECT @@session.character_set_connection AS charset, @@session.collation_connection AS collation',
            {}
          );

          expect(result.resultSets[0].rows).toEqual([{ charset: 'utf8mb4', collation: traits.collation }]);
        });
      });
    });

    describe('Per-tool readonly engine backstop: stacked statements and DDL', () => {
      // The READ ONLY transaction blocks DML; the session-level READ ONLY set
      // around it blocks DDL, which commits implicitly and would otherwise escape
      // the transaction. (Stacked-DDL payloads such as `SELECT 1--1;DROP TABLE t`
      // are also rejected upstream by the read-only classifier — see the unit
      // tests in allowed-keywords.test.ts.)
      it('should block a stacked UPDATE hidden after -- via the READ ONLY transaction', async () => {
        await this.withConnector(undefined, async (connector) => {
          // multipleStatements is on, so the server sees this as SELECT then
          // UPDATE. The READ ONLY transaction must reject the UPDATE (DML) at
          // the engine.
          await expect(
            connector.executeSQL("SELECT 1--1;UPDATE users SET name='hacked'", { readonly: true })
          ).rejects.toThrow(/read only|read-only/i);

          // No row should have been renamed.
          const check = await connector.executeSQL(
            "SELECT COUNT(*) AS c FROM users WHERE name='hacked'",
            {}
          );
          expect(Number(check.resultSets[0].rows[0].c)).toBe(0);
        });
      });

      it('should stop DDL, which commits implicitly, and leave the connection writable afterward', async () => {
        const table = 'dbhub_readonly_ddl';
        await this.withConnector(undefined, async (connector) => {
          const exists = async (): Promise<boolean> => {
            const result = await connector.executeSQL(
              `SELECT COUNT(*) AS c FROM information_schema.tables
               WHERE table_schema = DATABASE() AND table_name = '${table}'`,
              {}
            );
            return Number(result.resultSets[0].rows[0].c) > 0;
          };
          try {
            // CREATE TABLE performs an implicit COMMIT that ends the READ ONLY
            // transaction, so only the session-level READ ONLY stops it
            // (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION).
            const blocked = await settle(
              connector.executeSQL(`CREATE TABLE ${table} (id INT)`, { readonly: true })
            );
            expect(blocked.error?.errno).toBe(1792);
            expect(await exists()).toBe(false);

            // The session flag is cleared afterwards: the same pooled connection
            // serves writable tools too.
            await connector.executeSQL(`CREATE TABLE ${table} (id INT)`, {});
            expect(await exists()).toBe(true);
          } finally {
            await settle(connector.executeSQL(`DROP TABLE IF EXISTS ${table}`, {}));
          }
        });
      });
    });

    describe('query_timeout: client-side fallback', () => {
      const { sessionVariable, oneSecond, clientTimeoutCode, poolOfOne } = traits.queryTimeout;

      it('should fall back to the client-side timeout and kill the statement when the server limit is cleared', async () => {
        const probe = 'dbhub_client_timeout_probe';
        const pool = poolOfOne ? { poolMaxConnections: 1 } : {};
        await this.withConnector({ queryTimeoutSeconds: 1, ...pool }, (connector) =>
          this.withConnector(undefined, async (observer) => {
            const runningProbeCount = async (): Promise<number> => {
              const result = await observer.executeSQL(
                `SELECT COUNT(*) AS count FROM information_schema.processlist
                 WHERE info LIKE '%${probe}%' AND info NOT LIKE '%processlist%'`,
                {}
              );
              return Number(result.resultSets[0].rows[0].count);
            };

            // The batch clears the session limit first, so only the client-side
            // fallback is left to bound the SELECT.
            const result = await settle(
              connector.executeSQL(
                `SET SESSION ${sessionVariable} = 0; SELECT SLEEP(30), '${probe}'`,
                {}
              )
            );

            expect(result.error?.code).toBe(clientTimeoutCode);
            expect(result.elapsedMs).toBeGreaterThanOrEqual(1000 + CLIENT_QUERY_TIMEOUT_GRACE_MS - 100);
            expect(result.elapsedMs).toBeLessThan(10_000);
            expect(await waitFor(async () => (await runningProbeCount()) === 0, 2_000)).toBe(true);

            // The abandoned connection was discarded; a fresh one carries the limit again.
            const after = await connector.executeSQL(
              `SELECT @@session.${sessionVariable} AS server_limit`,
              { readonly: true }
            );
            expect(Number(after.resultSets[0].rows[0].server_limit)).toBe(oneSecond);
          })
        );
      }, 30_000);
    });
  }
}
