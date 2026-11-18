import { describe, it, expect } from 'vitest';
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb';
import { MariaDBConnector } from '../mariadb/index.js';
import { MySQLFamilyIntegrationTest } from './shared/mysql-family-suite.js';
import { settle } from './shared/query-timeout-helpers.js';
import { CLIENT_QUERY_TIMEOUT_GRACE_MS } from '../../utils/query-timeout.js';
import type { Connector } from '../interface.js';

class MariaDBIntegrationTest extends MySQLFamilyIntegrationTest<StartedMariaDbContainer> {
  createContainer(): Promise<StartedMariaDbContainer> {
    return new MariaDbContainer('mariadb:10.11')
      .withDatabase('testdb')
      .withRootPassword('rootpass')
      .start();
  }

  createConnector(): Connector {
    return new MariaDBConnector();
  }
}

const mariadbTest = new MariaDBIntegrationTest();

describe('MariaDB Connector Integration Tests', () => {
  mariadbTest.registerLifecycle();

  // Everything shared with MySQL, including the common connector tests.
  mariadbTest.createFamilyTests({
    // Against a server without TLS the driver's pool keeps retrying until its
    // own 10 s acquire timeout rather than reporting the refusal, so the test
    // gives up first.
    ssl: {
      requireFailure: /SSL|does not support SSL|timeout|ETIMEDOUT|Connection timeout/,
      requireDeadlineMs: 3000,
    },
    collation: 'utf8mb4_unicode_ci',
    queryTimeout: {
      sessionVariable: 'max_statement_time',
      oneSecond: 1,
      clientTimeoutCode: 'DBHUB_CLIENT_QUERY_TIMEOUT',
    },
  });

  describe('query_timeout: server-side limit', () => {
    it('should let the server stop a statement and keep the connection usable', async () => {
      await mariadbTest.withConnector({ queryTimeoutSeconds: 1 }, async (connector) => {
        const result = await settle(
          connector.executeSQL('SELECT SLEEP(30) AS slept', { readonly: true })
        );

        // The server ends the statement at max_statement_time (ER_STATEMENT_TIMEOUT,
        // or SLEEP() returning early), well before the client-side fallback.
        if (result.error) {
          expect(result.error.errno).toBe(1969);
        }
        expect(result.elapsedMs).toBeLessThan(CLIENT_QUERY_TIMEOUT_GRACE_MS);

        const after = await connector.executeSQL('SELECT 1 AS ok', { readonly: true });
        expect(Number(after.resultSets[0].rows[0].ok)).toBe(1);
      });
    }, 20_000);
  });
});
