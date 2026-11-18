import { describe, it, expect } from 'vitest';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import mysql from 'mysql2/promise';
import { MySQLConnector, applyOnEveryConnection } from '../mysql/index.js';
import { MySQLFamilyIntegrationTest } from './shared/mysql-family-suite.js';
import { settle } from './shared/query-timeout-helpers.js';
import { CLIENT_QUERY_TIMEOUT_GRACE_MS } from '../../utils/query-timeout.js';
import type { Connector } from '../interface.js';

class MySQLIntegrationTest extends MySQLFamilyIntegrationTest<StartedMySqlContainer> {
  createContainer(): Promise<StartedMySqlContainer> {
    return new MySqlContainer('mysql:8.0')
      .withDatabase('testdb')
      .withRootPassword('rootpass')
      .start();
  }

  createConnector(): Connector {
    return new MySQLConnector();
  }
}

const mysqlTest = new MySQLIntegrationTest();

describe('MySQL Connector Integration Tests', () => {
  mysqlTest.registerLifecycle();

  // Everything shared with MariaDB, including the common connector tests.
  mysqlTest.createFamilyTests({
    collation: 'utf8mb4_0900_ai_ci',
    queryTimeout: {
      sessionVariable: 'max_execution_time',
      oneSecond: 1000,
      clientTimeoutCode: 'PROTOCOL_SEQUENCE_TIMEOUT',
      poolOfOne: true,
    },
  });

  describe('timezone configuration', () => {
    // The driver reads the naive DATETIME in the configured zone and produces
    // the matching UTC instant. KST is UTC+9, so 02:31:23 on Sep 29 is
    // 17:31:23 UTC on the previous day (Sep 28); "Z" reads it as UTC already.
    it.each([
      { timezone: '+09:00', instant: '2025-09-28T17:31:23.000Z' },
      { timezone: 'Z', instant: '2025-09-29T02:31:23.000Z' },
    ])('should interpret DATETIME in the configured timezone $timezone', async ({ timezone, instant }) => {
      await mysqlTest.withConnector({ timezone }, async (connector) => {
        const result = await connector.executeSQL(
          "SELECT CAST('2025-09-29 02:31:23' AS DATETIME) AS dt",
          {}
        );

        expect(result.resultSets[0].rows).toHaveLength(1);
        const iso = new Date(result.resultSets[0].rows[0].dt as string | Date).toISOString();
        expect(iso).toBe(instant);
      });
    });
  });

  describe('charset configuration', () => {
    it('should use the charset default collation when charset is configured', async () => {
      // mysql2 maps charset "utf8mb4" to its default collation utf8mb4_general_ci,
      // which differs from mysql2's built-in default (utf8mb4_unicode_ci), so a
      // match proves the option took effect.
      await mysqlTest.withConnector({ charset: 'utf8mb4' }, async (connector) => {
        const result = await connector.executeSQL(
          'SELECT @@session.collation_connection AS collation',
          {}
        );

        expect(result.resultSets[0].rows).toEqual([{ collation: 'utf8mb4_general_ci' }]);
      });
    });
  });

  describe('pool_max_connections', () => {
    it('should stop waiting for a free connection after connection_timeout', async () => {
      await mysqlTest.withConnector(
        { poolMaxConnections: 1, connectionTimeoutSeconds: 1 },
        async (connector) => {
          const busy = connector.executeSQL('SELECT SLEEP(3)', {});
          const waiting = await settle(connector.executeSQL('SELECT 1 AS ok', {}));

          expect(waiting.error?.message).toBe(
            'Timed out after 1000 ms waiting for a free connection from the pool'
          );
          expect(waiting.elapsedMs).toBeGreaterThanOrEqual(900);
          expect(waiting.elapsedMs).toBeLessThan(2500);

          // The abandoned request gets the connection once SLEEP(3) ends and
          // hands it straight back, so the pool of one is still usable.
          await busy;
          const after = await connector.executeSQL('SELECT 1 AS ok', {});
          expect(Number(after.resultSets[0].rows[0].ok)).toBe(1);
        }
      );
    }, 20_000);
  });

  describe('query_timeout: server-side limit', () => {
    it('should let the server stop a read-only SELECT and keep the connection usable', async () => {
      await mysqlTest.withConnector({ queryTimeoutSeconds: 1 }, async (connector) => {
        const limit = await connector.executeSQL(
          'SELECT @@session.max_execution_time AS met',
          { readonly: true }
        );
        expect(Number(limit.resultSets[0].rows[0].met)).toBe(1000);

        const result = await settle(
          connector.executeSQL(
            `SELECT COUNT(*) FROM information_schema.columns a,
               information_schema.columns b, information_schema.columns c`,
            { readonly: true }
          )
        );

        // ER_QUERY_TIMEOUT from the server, well before the client-side fallback.
        expect(result.error?.errno).toBe(3024);
        expect(result.elapsedMs).toBeLessThan(CLIENT_QUERY_TIMEOUT_GRACE_MS);

        const after = await connector.executeSQL('SELECT 1 AS ok', { readonly: true });
        expect(Number(after.resultSets[0].rows[0].ok)).toBe(1);
      });
    }, 20_000);
  });

  describe('[sources.session] settings', () => {
    const tableExists = (name: string): Promise<boolean> =>
      mysqlTest.withConnector(undefined, async (observer) => {
        const result = await observer.executeSQL(
          `SELECT COUNT(*) AS c FROM information_schema.tables
           WHERE table_schema = 'testdb' AND table_name = '${name}'`,
          {}
        );
        return Number(result.resultSets[0].rows[0].c) > 0;
      });

    it('should apply each setting to every new connection as its default', async () => {
      await mysqlTest.withConnector(
        {
          queryTimeoutSeconds: 30,
          sessionSettings: { lock_wait_timeout: 5, time_zone: '+09:00', sql_safe_updates: true },
        },
        async (connector) => {
          const show =
            'SELECT SLEEP(0.2) AS s, @@session.lock_wait_timeout AS lwt, @@session.time_zone AS tz, ' +
            '@@session.sql_safe_updates AS safe, @@session.max_execution_time AS met';
          // Concurrent calls check out separate pool connections.
          const results = await Promise.all(
            [0, 1, 2].map(() => connector.executeSQL(show, { readonly: true }))
          );
          for (const result of results) {
            const row = result.resultSets[0].rows[0];
            expect(Number(row.lwt)).toBe(5);
            expect(row.tz).toBe('+09:00');
            expect(Number(row.safe)).toBe(1);
            // The query_timeout hook still applies alongside.
            expect(Number(row.met)).toBe(30000);
          }
        }
      );
    });

    it('should keep a read-only session default in force after a read-only execution', async () => {
      const table = 'dbhub_session_ro';
      await mysqlTest.withConnector(
        { sessionSettings: { transaction_read_only: 1 } },
        async (connector) => {
          // The read-only backstop raises and then restores the session flag; a
          // value configured here must survive it, so DDL is refused
          // (ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION) on read-only and writable
          // executions alike, in either order. The SELECT in between is what a
          // read-only tool could run to tamper with server-side state the
          // restore might read from: the restore must not depend on any.
          for (const readonly of [true, false, true]) {
            const result = await settle(
              connector.executeSQL(`CREATE TABLE ${table} (id INT)`, { readonly })
            );
            expect(result.error?.errno).toBe(1792);
            await connector.executeSQL('SELECT @dbhub_tx_read_only := 0 AS tampered', { readonly: true });
          }
          const flag = await connector.executeSQL('SELECT @@session.transaction_read_only AS ro', {});
          expect(Number(flag.resultSets[0].rows[0].ro)).toBe(1);
          expect(await tableExists(table)).toBe(false);
        }
      );
    });

    it('should fail to connect when the server rejects a setting', async () => {
      await expect(
        new MySQLConnector().connect(mysqlTest.connectionString, undefined, {
          sessionSettings: { no_such_variable: 1 },
        })
      ).rejects.toThrow(/Unknown system variable/);
    });

    it('should not send the queued statement when applying the settings fails', async () => {
      // Drive the hook directly with a statement the loader would never build,
      // to cover a SET that fails on a connection opened after startup.
      const pool = mysql.createPool(mysqlTest.connectionString);
      const table = 'dbhub_session_fail_closed';
      try {
        applyOnEveryConnection(pool, 'SET SESSION no_such_variable = 1');

        await expect(pool.query(`CREATE TABLE ${table} (id INT)`)).rejects.toThrow(
          /Unknown system variable/
        );
        expect(await tableExists(table)).toBe(false);
      } finally {
        await pool.end();
      }
    });
  });
});
