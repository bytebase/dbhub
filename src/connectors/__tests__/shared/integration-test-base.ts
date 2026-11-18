import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Connector, ConnectorConfig } from '../../interface.js';

export interface DatabaseTestConfig {
  expectedSchemas: string[];
  expectedTables: string[];
  expectedTestSchemaTable?: string;
  testSchema?: string;
  supportsStoredProcedures?: boolean;
  expectedStoredProcedures?: string[];
  supportsComments?: boolean;
  /**
   * The statement that opens a user transaction inside a batch (`BEGIN
   * TRANSACTION`, `START TRANSACTION`). Enables the commit/rollback batch test.
   */
  beginTransaction?: string;
  /**
   * What the engine raises for a write under `options.readonly`. Omit for an
   * engine whose backstop rolls the write back without an error (SQL Server).
   */
  readonlyWriteError?: RegExp;
}

/**
 * The shared tests create `users` with columns `id`, `name`, ... unquoted, and
 * engines differ in how they report such identifiers back (Oracle folds them
 * to `USERS`, `ID`, `NAME`). Lookups by name here are therefore
 * case-insensitive; the engine-specific suites assert the exact casing.
 */
function sameIdentifier(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function findColumn<T extends { column_name: string }>(columns: T[], name: string): T | undefined {
  return columns.find((col) => sameIdentifier(col.column_name, name));
}

function rowValue(row: Record<string, unknown>, key: string): unknown {
  const actual = Object.keys(row).find((k) => sameIdentifier(k, key));
  return actual === undefined ? undefined : row[actual];
}

/** A started Testcontainers database satisfies this as is. */
export interface TestContainer {
  getConnectionUri(): string;
  stop(): Promise<unknown>;
}

/**
 * Base class for database integration tests that provides common test patterns
 */
export abstract class IntegrationTestBase<TContainer extends TestContainer> {
  protected container!: TContainer;
  public connector!: Connector;
  public connectionString!: string;
  public config: DatabaseTestConfig;

  constructor(config: DatabaseTestConfig) {
    this.config = config;
  }

  /**
   * Abstract methods that must be implemented by specific database test classes
   */
  abstract createContainer(): Promise<TContainer>;
  abstract createConnector(): Connector;
  abstract setupTestData(connector: Connector): Promise<void>;

  /**
   * Setup method to be called in beforeAll
   */
  async setup(): Promise<void> {
    console.log('Starting database container...');

    this.container = await this.createContainer();
    console.log('Container started, getting connection details...');

    this.connectionString = this.container.getConnectionUri();
    console.log('Connection URI:', this.connectionString);

    this.connector = this.createConnector();
    await this.connector.connect(this.connectionString);
    console.log('Connected to database');

    await this.setupTestData(this.connector);
    console.log('Test data setup complete');
  }

  /**
   * Cleanup method to be called in afterAll
   */
  async cleanup(): Promise<void> {
    // Stop the container even if disconnecting throws: a connector error
    // here must not leak a running container into the next suite (or onto
    // the CI runner). A disconnect that never settles is bounded only by the
    // integration project's hookTimeout, not by this block.
    try {
      if (this.connector) {
        await this.connector.disconnect();
      }
    } finally {
      if (this.container) {
        await this.container.stop();
      }
    }
  }

  /**
   * Register setup/cleanup for the enclosing describe. `startupTimeoutMs`
   * covers the image pull and database startup; teardown takes no timeout of
   * its own so that it gets the integration project's hookTimeout.
   */
  registerLifecycle(startupTimeoutMs = 120_000): void {
    beforeAll(() => this.setup(), startupTimeoutMs);
    afterAll(() => this.cleanup());
  }

  /**
   * Run `fn` against a separate connector connected to this suite's database
   * with `config`, disconnecting it afterwards whatever happens.
   */
  async withConnector<T>(
    config: ConnectorConfig | undefined,
    fn: (connector: Connector) => Promise<T>
  ): Promise<T> {
    const connector = this.createConnector();
    try {
      await connector.connect(this.connectionString, undefined, config);
      return await fn(connector);
    } finally {
      await connector.disconnect();
    }
  }

  /** Every shared suite a connector runs; `config` gates what an engine lacks. */
  createCommonTests(): void {
    this.createConnectionTests();
    this.createSchemaTests();
    this.createTableTests();
    this.createSQLExecutionTests();
    if (this.config.supportsStoredProcedures) {
      this.createStoredProcedureTests();
    }
    this.createCommentTests();
    this.createErrorHandlingTests();
    this.createMaxRowsTests();
    this.createReadonlyBackstopTests();
  }

  createConnectionTests(): void {
    describe('Connection', () => {
      it('should validate DSN format', () => {
        const sampleDSN = this.connector.dsnParser.getSampleDSN();
        expect(sampleDSN).toContain('://');
        expect(this.connector.dsnParser.isValidDSN(sampleDSN)).toBe(true);
        expect(this.connector.dsnParser.isValidDSN('invalid-dsn')).toBe(false);
      });
    });
  }

  /**
   * Assert, from the server's own view of `connector`'s session, whether it
   * is TLS-encrypted. Implemented by the suites that call createSSLTests().
   */
  protected expectSessionEncryption?(connector: Connector, encrypted: boolean): Promise<void>;

  /**
   * `sslmode=disable` and `sslmode=require` against the test container, whose
   * DSN must not already carry an sslmode.
   *
   * The container may have no TLS set up, so `require` passes either with an
   * encrypted session or with a connection refused for that reason
   * (`requireFailure`). `requireDeadlineMs` gives up on a driver that keeps
   * retrying instead of reporting the refusal.
   */
  createSSLTests(
    { requireFailure = /SSL|does not support SSL/, requireDeadlineMs }: {
      requireFailure?: RegExp;
      requireDeadlineMs?: number;
    } = {}
  ): void {
    const dsnWith = (sslmode: string): string =>
      `${this.connectionString}${this.connectionString.includes('?') ? '&' : '?'}sslmode=${sslmode}`;

    describe('SSL Connection Tests', () => {
      it('should handle SSL mode disable connection', async () => {
        const connector = this.createConnector();
        try {
          await connector.connect(dsnWith('disable'));
          await this.expectSessionEncryption!(connector, false);
        } finally {
          await connector.disconnect();
        }
      });

      it('should handle SSL mode require connection', async () => {
        const connector = this.createConnector();
        const connecting = connector.connect(dsnWith('require'));
        try {
          await (requireDeadlineMs === undefined
            ? connecting
            : Promise.race([
                connecting,
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Connection timeout')), requireDeadlineMs)
                ),
              ]));
        } catch (error) {
          // A failed connect() has already torn its own pool down.
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(requireFailure);
          return;
        }
        try {
          await this.expectSessionEncryption!(connector, true);
        } finally {
          await connector.disconnect();
        }
      });
    });
  }

  createSchemaTests(): void {
    describe('Schema Operations', () => {
      it('should list schemas', async () => {
        const schemas = await this.connector.getSchemas();
        this.config.expectedSchemas.forEach(expectedSchema => {
          expect(schemas).toContain(expectedSchema);
        });
      });

      it('should list tables in default schema', async () => {
        const tables = await this.connector.getTables();
        this.config.expectedTables.forEach(expectedTable => {
          expect(tables).toContain(expectedTable);
        });
      });

      if (this.config.testSchema && this.config.expectedTestSchemaTable) {
        it('should list tables in specific schema', async () => {
          const tables = await this.connector.getTables(this.config.testSchema);
          expect(tables).toContain(this.config.expectedTestSchemaTable);
        });
      }

      it('should list views without overlapping tables', async () => {
        // Verifies getViews() is wired and its query executes against the real
        // database. getTables() (tables, never views) and getViews() must be disjoint.
        const tables = await this.connector.getTables();
        const views = await this.connector.getViews();
        expect(Array.isArray(views)).toBe(true);

        const tableSet = new Set(tables);
        for (const view of views) {
          expect(tableSet.has(view)).toBe(false);
        }
      });

    });
  }

  createTableTests(): void {
    describe('Table Schema Operations', () => {
      it('should get table schema for users table', async () => {
        const schema = await this.connector.getTableSchema('users');
        expect(schema.length).toBeGreaterThan(0);

        const idColumn = findColumn(schema, 'id');
        expect(idColumn).toBeDefined();
        expect(idColumn?.is_nullable).toBe('NO');

        const nameColumn = findColumn(schema, 'name');
        expect(nameColumn).toBeDefined();
      });

      it('should get table indexes', async () => {
        const indexes = await this.connector.getTableIndexes('users');
        expect(indexes.length).toBeGreaterThan(0);

        const primaryIndex = indexes.find(idx => idx.is_primary);
        expect(primaryIndex).toBeDefined();
        expect(primaryIndex?.column_names.some((c) => sameIdentifier(c, 'id'))).toBe(true);
      });
    });
  }

  createSQLExecutionTests(): void {
    describe('SQL Execution', () => {
      it('should execute INSERT and SELECT', async () => {
        const insertResult = await this.connector.executeSQL(
          "INSERT INTO users (name, email, age) VALUES ('Test User', 'test@example.com', 25)", {}
        );
        expect(insertResult).toBeDefined();

        const selectResult = await this.connector.executeSQL(
          "SELECT * FROM users WHERE email = 'test@example.com'", {}
        );
        expect(selectResult.resultSets[0].rows).toHaveLength(1);
        expect(rowValue(selectResult.resultSets[0].rows[0], 'name')).toBe('Test User');
        expect(Number(rowValue(selectResult.resultSets[0].rows[0], 'age'))).toBe(25);
      });

      it('should keep every column when names repeat', async () => {
        // Every driver's default row object is keyed by column name, so the
        // second `n` used to overwrite the first (bytebase/dbhub#484). The
        // first column keeps its name; the repeat is suffixed `_1`.
        const result = await this.connector.executeSQL(
          'SELECT COUNT(*) AS n, COUNT(*) + 1 AS n FROM users', {}
        );
        expect(result.resultSets[0].rows).toHaveLength(1);
        const row = result.resultSets[0].rows[0];
        expect(Object.keys(row)).toHaveLength(2);
        const first = Number(rowValue(row, 'n'));
        expect(first).toBeGreaterThanOrEqual(3);
        expect(Number(rowValue(row, 'n_1'))).toBe(first + 1);
      });

      const begin = this.config.beginTransaction;
      if (begin) {
        it('should persist a batch that commits its own transaction and discard one that rolls back', async () => {
          // The whole batch has to reach one session for either to hold.
          const countTransactionUsers = async (): Promise<number> => {
            const result = await this.connector.executeSQL(
              "SELECT COUNT(*) AS n FROM users WHERE email LIKE 'tx%@example.com'", {}
            );
            return Number(rowValue(result.resultSets[0].rows[0], 'n'));
          };

          await this.connector.executeSQL(`
            ${begin};
            INSERT INTO users (name, email, age) VALUES ('Transaction User 1', 'tx1@example.com', 45);
            INSERT INTO users (name, email, age) VALUES ('Transaction User 2', 'tx2@example.com', 50);
            COMMIT;
          `, {});
          expect(await countTransactionUsers()).toBe(2);

          await this.connector.executeSQL(`
            ${begin};
            INSERT INTO users (name, email, age) VALUES ('Transaction User 3', 'tx3@example.com', 55);
            ROLLBACK;
          `, {});
          expect(await countTransactionUsers()).toBe(2);
        });
      }
    });
  }

  /**
   * A row-returning statement over `users`, ordered by id, that carries its
   * own limit of `rows` in the engine's syntax.
   */
  protected userLimitedSQL(rows: number): string {
    return `SELECT * FROM users ORDER BY id LIMIT ${rows}`;
  }

  /**
   * sql-row-limiter.test.ts covers the text of every rewrite. These prove the
   * rewritten SQL runs on the real engine, and that the connector drops the
   * probe row and flags the result set.
   */
  createMaxRowsTests(): void {
    describe('maxRows', () => {
      const names = (rows: Record<string, unknown>[]): unknown[] =>
        rows.map((row) => rowValue(row, 'name'));

      it('should cap a SELECT and flag it truncated', async () => {
        const sql = 'SELECT * FROM users ORDER BY id';
        const result = await this.connector.executeSQL(sql, { maxRows: 2 });

        // The dropped probe row must not surface as a spurious extra result set.
        expect(result.resultSets).toHaveLength(1);
        expect(names(result.resultSets[0].rows)).toEqual(['John Doe', 'Jane Smith']);
        // The cap provably cut off rows (users has more than 2)
        expect(result.resultSets[0].truncated).toBe(true);
        // The echoed SQL is the original statement, not the probe rewrite
        expect(result.resultSets[0].sql).toBe(sql);
      });

      it('should not flag truncated when the result has exactly maxRows rows', async () => {
        // Exactly 2 rows match and the cap is 2 — indistinguishable by count
        // alone, but the missing probe row proves the result is complete
        const result = await this.connector.executeSQL(
          'SELECT name FROM users WHERE id <= 2 ORDER BY id',
          { maxRows: 2 }
        );

        expect(result.resultSets[0].rows).toHaveLength(2);
        expect(result.resultSets[0].truncated).toBeUndefined();
      });

      it("should respect the statement's own limit when lower than maxRows", async () => {
        const result = await this.connector.executeSQL(this.userLimitedSQL(1), { maxRows: 3 });

        expect(names(result.resultSets[0].rows)).toEqual(['John Doe']);
        // The user's own limit fired, not the cap — no truncation flag
        expect(result.resultSets[0].truncated).toBeUndefined();
      });

      it("should cap the statement's own limit when higher than maxRows", async () => {
        const result = await this.connector.executeSQL(this.userLimitedSQL(10), { maxRows: 2 });

        expect(names(result.resultSets[0].rows)).toEqual(['John Doe', 'Jane Smith']);
        expect(result.resultSets[0].truncated).toBe(true);
      });

      it('should not affect non-SELECT queries', async () => {
        const insertResult = await this.connector.executeSQL(
          "INSERT INTO users (name, email, age) VALUES ('MaxRows Test', 'maxrows@example.com', 25)",
          { maxRows: 1 }
        );
        expect(insertResult.resultSets[0].rows).toHaveLength(0); // INSERTs don't return rows by default

        // Verify the insert worked
        const selectResult = await this.connector.executeSQL(
          "SELECT * FROM users WHERE email = 'maxrows@example.com'",
          {}
        );
        expect(names(selectResult.resultSets[0].rows)).toEqual(['MaxRows Test']);
      });

      it('should cap and flag each statement of a batch on its own', async () => {
        const result = await this.connector.executeSQL(
          'SELECT name FROM users ORDER BY id; SELECT name FROM users WHERE id = 1;',
          { maxRows: 2 }
        );

        // One resultSet per statement, in source order.
        expect(result.resultSets).toHaveLength(2);
        expect(names(result.resultSets[0].rows)).toEqual(['John Doe', 'Jane Smith']);
        expect(result.resultSets[0].truncated).toBe(true);
        expect(names(result.resultSets[1].rows)).toEqual(['John Doe']);
        expect(result.resultSets[1].truncated).toBeUndefined();
      });
    });
  }

  createReadonlyBackstopTests(): void {
    describe('Per-tool readonly engine backstop (options.readonly)', () => {
      // The realistic config: the connection is writable (read-only and
      // writable tools share it) and read-only is enforced per execution by
      // the engine, behind the keyword classifier.
      it('should not persist a write under options.readonly, and stay writable for later calls', async () => {
        await this.withConnector(undefined, async (connector) => {
          const write = connector.executeSQL(
            "INSERT INTO users (name, email) VALUES ('ro', 'ro@example.com')",
            { readonly: true }
          );
          if (this.config.readonlyWriteError) {
            await expect(write).rejects.toThrow(this.config.readonlyWriteError);
          } else {
            await write;
          }
          // Reads still work under the backstop, and show nothing was written.
          const check = await connector.executeSQL(
            "SELECT COUNT(*) AS n FROM users WHERE email = 'ro@example.com'",
            { readonly: true }
          );
          expect(Number(rowValue(check.resultSets[0].rows[0], 'n'))).toBe(0);

          // The read-only call must not leave the session read-only: the same
          // connection serves writable tools too.
          const insert = await connector.executeSQL(
            "INSERT INTO users (name, email) VALUES ('rw', 'rw@example.com')", {}
          );
          expect(insert.resultSets[0].rowCount).toBe(1);
          await connector.executeSQL("DELETE FROM users WHERE email = 'rw@example.com'", {});
        });
      });
    });
  }

  createStoredProcedureTests(): void {
    describe('Stored Procedures', () => {
      it('should list stored procedures', async () => {
        const procedures = await this.connector.getStoredProcedures();
        if (this.config.expectedStoredProcedures) {
          this.config.expectedStoredProcedures.forEach(expectedProc => {
            expect(procedures).toContain(expectedProc);
          });
        }
      });

      if (this.config.expectedStoredProcedures?.length) {
        it('should get stored procedure details', async () => {
          const procedureName = this.config.expectedStoredProcedures![0];
          const procedure = await this.connector.getStoredProcedureDetail(procedureName);
          expect(procedure.procedure_name).toBe(procedureName);
          expect(procedure.procedure_type).toMatch(/function|procedure/);
        });
      }
    });
  }

  createCommentTests(): void {
    describe('Table and Column Comments', () => {
      it('should include description field in table schema columns', async () => {
        const schema = await this.connector.getTableSchema('users');
        expect(schema.length).toBeGreaterThan(0);

        // Every column should have the description field (even if null)
        for (const col of schema) {
          expect(col).toHaveProperty('description');
        }

        if (this.config.supportsComments) {
          // Databases with comments should return the descriptions we set
          const nameColumn = findColumn(schema, 'name');
          expect(nameColumn?.description).toBe('Full name of the user');

          const emailColumn = findColumn(schema, 'email');
          expect(emailColumn?.description).toBe('Unique email address');

          // Columns without comments should have null description
          const ageColumn = findColumn(schema, 'age');
          expect(ageColumn?.description).toBeNull();
        } else {
          // Databases without comment support (SQLite) should return null
          for (const col of schema) {
            expect(col.description).toBeNull();
          }
        }
      });

      if (this.config.supportsComments) {
        it('should return table comment via getTableComment', async () => {
          expect(this.connector.getTableComment).toBeDefined();
          const comment = await this.connector.getTableComment!('users');
          expect(comment).toBe('Application users');
        });

        it('should return null for table without comment', async () => {
          expect(this.connector.getTableComment).toBeDefined();
          const comment = await this.connector.getTableComment!('orders');
          expect(comment).toBeNull();
        });
      }
    });
  }

  createErrorHandlingTests(): void {
    describe('Error Handling', () => {
      it('should handle invalid SQL gracefully', async () => {
        await expect(
          this.connector.executeSQL('SELECT * FROM nonexistent_table', {})
        ).rejects.toThrow();
      });

      it('should handle connection errors', async () => {
        const newConnector = this.createConnector();
        await expect(
          newConnector.executeSQL('SELECT 1', {})
        ).rejects.toThrow(/Not connected to.*database/);
      });

      it('should handle invalid table schema requests', async () => {
        const result = await this.connector.getTableSchema('nonexistent_table');
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBe(0);
      });

      it('should keep the failing statement and its parameters out of stderr', async () => {
        // A failing statement carries whatever the caller put in it, and stderr
        // is retained and read more widely than the database itself — on the
        // stdio transport it is the MCP client that collects it. The error is
        // re-thrown to the caller, so nothing needs to be logged here.
        // Parameters are passed because the connectors only reached their
        // logging on the parameterized path.
        const marker = 'dbhub_stderr_marker_value';
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
          await expect(
            this.connector.executeSQL('SELECT * FROM nonexistent_table', {}, [marker])
          ).rejects.toThrow();

          const logged = stderr.mock.calls.map((args) => args.join(' ')).join('\n');
          expect(logged).not.toContain(marker);
          expect(logged).not.toContain('nonexistent_table');
        } finally {
          stderr.mockRestore();
        }
      });
    });
  }
}
