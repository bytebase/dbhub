import { describe, it, expect } from 'vitest';
import { MSSQLServerContainer, type StartedMSSQLServerContainer } from '@testcontainers/mssqlserver';
import { SQLServerConnector } from '../sqlserver/index.js';
import { IntegrationTestBase, type TestContainer, type DatabaseTestConfig } from './shared/integration-test-base.js';
import type { Connector } from '../interface.js';

class SQLServerTestContainer implements TestContainer {
  constructor(private container: StartedMSSQLServerContainer) {}

  getConnectionUri(): string {
    // Convert to our expected DSN format: sqlserver://username:password@host:port/database
    // Use sslmode=disable for test containers to avoid certificate issues
    const host = this.container.getHost();
    const port = this.container.getMappedPort(1433);
    return `sqlserver://sa:Password123!@${host}:${port}/master?sslmode=disable`;
  }

  stop(): Promise<unknown> {
    return this.container.stop();
  }
}

class SQLServerIntegrationTest extends IntegrationTestBase<SQLServerTestContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      expectedSchemas: ['dbo', 'INFORMATION_SCHEMA'],
      expectedTables: ['users', 'orders', 'products'],
      supportsStoredProcedures: true,
      expectedStoredProcedures: ['GetUserCount', 'CalculateTotalAge'],
      supportsComments: true,
      beginTransaction: 'BEGIN TRANSACTION',
      // No readonlyWriteError: SQL Server has no READ ONLY transaction, so a
      // read-only write succeeds inside a transaction that is rolled back.
    };
    super(config);
  }

  async createContainer(): Promise<SQLServerTestContainer> {
    const container = await new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2019-latest')
      .acceptLicense() // Required for SQL Server containers
      .withPassword('Password123!')
      .start();
    
    return new SQLServerTestContainer(container);
  }

  createConnector(): Connector {
    return new SQLServerConnector();
  }

  protected userLimitedSQL(rows: number): string {
    return `SELECT TOP ${rows} * FROM users ORDER BY id`;
  }

  async setupTestData(connector: Connector): Promise<void> {
    // Create users table
    await connector.executeSQL(`
      CREATE TABLE users (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(100) NOT NULL,
        email NVARCHAR(100) UNIQUE NOT NULL,
        age INT
      )
    `, {});

    // Create orders table
    await connector.executeSQL(`
      CREATE TABLE orders (
        id INT IDENTITY(1,1) PRIMARY KEY,
        user_id INT,
        total DECIMAL(10,2),
        created_at DATETIME2 DEFAULT GETDATE(),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `, {});

    // Create products table
    await connector.executeSQL(`
      CREATE TABLE products (
        id INT IDENTITY(1,1) PRIMARY KEY,
        name NVARCHAR(100) NOT NULL,
        price DECIMAL(10,2)
      )
    `, {});

    // Add table and column comments via extended properties
    await connector.executeSQL(`
      EXEC sp_addextendedproperty
        @name = N'MS_Description',
        @value = N'Application users',
        @level0type = N'SCHEMA', @level0name = N'dbo',
        @level1type = N'TABLE',  @level1name = N'users'
    `, {});
    await connector.executeSQL(`
      EXEC sp_addextendedproperty
        @name = N'MS_Description',
        @value = N'Full name of the user',
        @level0type = N'SCHEMA', @level0name = N'dbo',
        @level1type = N'TABLE',  @level1name = N'users',
        @level2type = N'COLUMN', @level2name = N'name'
    `, {});
    await connector.executeSQL(`
      EXEC sp_addextendedproperty
        @name = N'MS_Description',
        @value = N'Unique email address',
        @level0type = N'SCHEMA', @level0name = N'dbo',
        @level1type = N'TABLE',  @level1name = N'users',
        @level2type = N'COLUMN', @level2name = N'email'
    `, {});

    // Insert test data
    await connector.executeSQL(`
      INSERT INTO users (name, email, age) VALUES
      ('John Doe', 'john@example.com', 30),
      ('Jane Smith', 'jane@example.com', 25),
      ('Bob Johnson', 'bob@example.com', 35)
    `, {});

    await connector.executeSQL(`
      INSERT INTO orders (user_id, total) VALUES 
      (1, 99.99),
      (1, 149.50),
      (2, 75.25)
    `, {});

    await connector.executeSQL(`
      INSERT INTO products (name, price) VALUES 
      ('Widget A', 19.99),
      ('Widget B', 29.99)
    `, {});

    // Create test stored functions/procedures
    await connector.executeSQL(`
      CREATE FUNCTION GetUserCount()
      RETURNS INT
      AS
      BEGIN
        DECLARE @count INT
        SELECT @count = COUNT(*) FROM users
        RETURN @count
      END
    `, {});

    await connector.executeSQL(`
      CREATE FUNCTION CalculateTotalAge()
      RETURNS INT
      AS
      BEGIN
        DECLARE @total INT
        SELECT @total = ISNULL(SUM(age), 0) FROM users WHERE age IS NOT NULL
        RETURN @total
      END
    `, {});
  }
}


const sqlServerTest = new SQLServerIntegrationTest();

// NOTE: SQL Server containers may take several minutes to start due to licensing requirements
// and initialization time. If tests time out, consider increasing timeout or running with
// more Docker resources allocated.
describe('SQL Server Connector Integration Tests', () => {
  sqlServerTest.registerLifecycle(300_000); // 5 minutes for the SQL Server container

  sqlServerTest.createCommonTests();

  const execute = (sql: string, options: { readonly?: boolean; maxRows?: number } = {}, parameters?: any[]) =>
    sqlServerTest.connector.executeSQL(sql, options, parameters);
  const planOf = async (...args: Parameters<typeof execute>): Promise<string> =>
    (await execute(...args)).resultSets[0].rows[0].plan as string;

  describe('SQL Server SSL/TLS Configuration', () => {
    it('should connect unencrypted with sslmode=disable', async () => {
      // The suite's own DSN carries sslmode=disable.
      const result = await execute(
        'SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID'
      );
      expect(result.resultSets[0].rows).toEqual([{ encrypt_option: 'FALSE' }]);
    });
  });

  describe('EXPLAIN emulation', () => {
    it('should return an execution plan for EXPLAIN <query> (SHOWPLAN_XML)', async () => {
      const result = await execute('EXPLAIN SELECT * FROM users WHERE age > 30');

      expect(result.resultSets[0].rows).toHaveLength(1);
      const planXml = result.resultSets[0].rows[0].plan as string;
      expect(typeof planXml).toBe('string');
      // SHOWPLAN_XML output is a ShowPlanXML document referencing the query.
      expect(planXml).toContain('ShowPlanXML');
      expect(planXml).toContain('users');
    });

    it('should return an actual execution plan for EXPLAIN ANALYZE <query> (STATISTICS XML)', async () => {
      const result = await execute('EXPLAIN ANALYZE SELECT * FROM users WHERE age > 30');

      expect(result.resultSets[0].rows).toHaveLength(1);
      const planXml = result.resultSets[0].rows[0].plan as string;
      expect(typeof planXml).toBe('string');
      expect(planXml).toContain('ShowPlanXML');
      expect(planXml).toContain('users');
      // RunTimeInformation/ActualRows only appear in an *actual* plan
      // (SET STATISTICS XML). SHOWPLAN_XML never emits them.
      expect(planXml).toContain('RunTimeInformation');
      expect(planXml).toMatch(/ActualRows/i);
    });

    // Which plan each spelling selects. A disabled ANALYZE must read as a
    // plain estimated EXPLAIN, in the parenthesized form and in the bare and
    // equals spellings alike: that is how the read-only classifier reads them
    // (it does not count a disabled ANALYZE as executing), and erroring or
    // executing here would disagree with what that layer waves through.
    it.each([
      { sql: '/* inspect plan */ EXPLAIN SELECT * FROM users', actual: false },
      { sql: '/* real numbers please */ EXPLAIN ANALYZE SELECT * FROM users', actual: true },
      { sql: 'EXPLAIN (ANALYZE) SELECT name FROM users WHERE age > 30', actual: true },
      { sql: 'EXPLAIN (ANALYZE = true) SELECT name FROM users WHERE age > 30', actual: true },
      { sql: 'EXPLAIN (ANALYZE false) SELECT name FROM users WHERE age > 30', actual: false },
      { sql: 'EXPLAIN (ANALYZE = false) SELECT name FROM users WHERE age > 30', actual: false },
      { sql: 'EXPLAIN (ANALYZE = 0) SELECT name FROM users WHERE age > 30', actual: false },
      { sql: 'EXPLAIN ANALYZE = false SELECT name FROM users WHERE age > 30', actual: false },
      { sql: 'EXPLAIN ANALYZE false SELECT name FROM users WHERE age > 30', actual: false },
    ])('should return a plan with runtime counters: $actual for "$sql"', async ({ sql, actual }) => {
      const plan = await planOf(sql);
      expect(plan).toContain('ShowPlanXML');
      // An estimated plan has no runtime counters.
      expect(plan.includes('RunTimeInformation')).toBe(actual);
    });

    // Whether the explained statement runs, and whether its write sticks.
    it.each([
      // SHOWPLAN_XML compiles without executing.
      { form: 'EXPLAIN', readonly: false, persisted: 0, tag: 'noexec' },
      { form: 'EXPLAIN (ANALYZE off)', readonly: false, persisted: 0, tag: 'analyze-off' },
      // Unlike EXPLAIN, EXPLAIN ANALYZE really runs the statement...
      { form: 'EXPLAIN ANALYZE', readonly: false, persisted: 1, tag: 'analyze-exec' },
      // ...and in read-only mode that run is rolled back.
      { form: 'EXPLAIN ANALYZE', readonly: true, persisted: 0, tag: 'analyze-ro' },
    ])(
      'should leave $persisted row(s) behind for $form <INSERT> (readonly: $readonly)',
      async ({ form, readonly, persisted, tag }) => {
        const email = `explain-${tag}@example.com`;
        const count = async (): Promise<number> => {
          const result = await execute(`SELECT COUNT(*) as count FROM users WHERE email = '${email}'`);
          return Number(result.resultSets[0].rows[0].count);
        };
        expect(await count()).toBe(0);

        // The plan comes back either way.
        const plan = await planOf(
          `${form} INSERT INTO users (name, email, age) VALUES ('Explained', '${email}', 42)`,
          { readonly }
        );
        expect(plan).toContain('ShowPlanXML');

        expect(await count()).toBe(persisted);
      }
    );

    it('should reject SET SHOWPLAN smuggled into an EXPLAIN query', async () => {
      const before = await execute('SELECT COUNT(*) as count FROM users');

      await expect(
        execute('EXPLAIN SET SHOWPLAN_XML OFF DELETE FROM users')
      ).rejects.toThrow(/SET SHOWPLAN/i);

      const after = await execute('SELECT COUNT(*) as count FROM users');
      expect(Number(after.resultSets[0].rows[0].count)).toBe(Number(before.resultSets[0].rows[0].count));
    });

    it.each([
      // Empty and comment-only statements.
      { sql: 'EXPLAIN   ', error: /requires a statement/i },
      { sql: 'EXPLAIN /* just a comment */', error: /requires a statement/i },
      { sql: 'EXPLAIN ANALYZE   ', error: /requires a statement/i },
      { sql: 'EXPLAIN (ANALYZE)   ', error: /requires a statement/i },
      { sql: 'EXPLAIN ANALYZE SET STATISTICS XML OFF SELECT * FROM users', error: /SET STATISTICS/i },
      // PostgreSQL-only options are refused by name, not silently dropped.
      { sql: 'EXPLAIN (ANALYZE, BUFFERS) SELECT name FROM users', error: /BUFFERS/i },
      { sql: 'EXPLAIN ANALYZE VERBOSE SELECT name FROM users', error: /VERBOSE/i },
      { sql: 'EXPLAIN (COSTS) SELECT name FROM users', error: /COSTS/i },
      { sql: 'EXPLAIN (ANALYZE SELECT name FROM users', error: /option list/i },
      // Read-only EXPLAIN ANALYZE executes, guarded only by the rollback.
      // OPENQUERY executes on the remote source, so the rollback never
      // reaches it — the same escape the plain EXPLAIN path blocks.
      {
        sql: "EXPLAIN ANALYZE SELECT * FROM OPENQUERY(remote, 'SELECT 1')",
        readonly: true,
        error: /pass-through data sources/i,
      },
      { sql: 'EXPLAIN ANALYZE EXEC GetUserCount', readonly: true, error: /dynamic SQL/i },
    ])('should reject "$sql" with $error', async ({ sql, readonly, error }) => {
      await expect(execute(sql, { readonly })).rejects.toThrow(error);
    });

    it('should bind parameters for EXPLAIN ANALYZE', async () => {
      // Binding is what makes this work at all: an unbound @p1 fails with
      // "Must declare the scalar variable", so succeeding proves it was bound.
      const plan = await planOf(
        'EXPLAIN ANALYZE SELECT n FROM (VALUES (1), (2), (3)) AS t(n) WHERE n <= @p1',
        {},
        [2]
      );

      expect(plan).toContain('RunTimeInformation');
      // Two of the three rows pass the filter, so the value reached the server
      // rather than merely being declared.
      expect(plan).toMatch(/ActualRows="2"/);
    });

    it('should bind parameters for plain EXPLAIN', async () => {
      // SHOWPLAN compiles without executing, so the DECLARE/SET node-mssql
      // prepends never assigns — but the statement must still compile, and the
      // plan comes back estimated.
      const plan = await planOf('EXPLAIN SELECT name FROM users WHERE age > @p1', {}, [30]);

      expect(plan).toContain('ShowPlanXML');
      expect(plan).not.toContain('RunTimeInformation');
    });

    it('should bind parameters for EXPLAIN ANALYZE in readonly mode', async () => {
      const plan = await planOf(
        'EXPLAIN ANALYZE SELECT n FROM (VALUES (1), (2), (3)) AS t(n) WHERE n <= @p1',
        { readonly: true },
        [1]
      );

      expect(plan).toContain('RunTimeInformation');
      expect(plan).toMatch(/ActualRows="1"/);
    });
  });

  describe('SQL Server-specific Features', () => {
    it('should report connection pool state and buffer cache hit ratio via getHealthCheck', async () => {
      const health = await sqlServerTest.connector.getHealthCheck!();

      // The sa test user has VIEW SERVER STATE, so both sections should be
      // populated rather than degraded to a `notes` entry.
      expect(health.notes).toBeUndefined();

      expect(health.connections).toBeDefined();
      expect(health.connections!.total).toBeGreaterThanOrEqual(0);
      expect(health.connections!.idleInTransaction).toBeGreaterThanOrEqual(0);
      expect(health.connections!.idleInTransactionAborted).toBeUndefined();

      expect(health.bufferCache).toBeDefined();
      if (health.bufferCache!.hitRatioPct !== null) {
        expect(health.bufferCache!.hitRatioPct).toBeGreaterThanOrEqual(0);
        expect(health.bufferCache!.hitRatioPct).toBeLessThanOrEqual(100);
      }
    });

    it('should return the rows of a write with an OUTPUT clause as its only result set', async () => {
      const result = await execute(`
        INSERT INTO users (name, email, age) 
        OUTPUT INSERTED.id, INSERTED.name
        VALUES ('Output Test', 'output@example.com', 40)
      `);
      
      // The rows the write returned are not counted again as a write-only set.
      expect(result.resultSets).toHaveLength(1);
      expect(result.resultSets[0].rows).toHaveLength(1);
      expect(result.resultSets[0].rows[0].id).toBeDefined();
      expect(result.resultSets[0].rows[0].name).toBe('Output Test');
    });

    it('should send a MERGE with the terminating semicolon it requires', async () => {
      // Create a staging table
      await execute(`
        CREATE TABLE users_staging (
          id INT,
          name NVARCHAR(100),
          email NVARCHAR(100),
          age INT
        )
      `);

      await execute(`
        INSERT INTO users_staging (id, name, email, age) VALUES 
        (1, 'John Doe Updated', 'john@example.com', 31),
        (999, 'New User', 'new@example.com', 25)
      `);

      const result = await execute(`
        MERGE users AS target
        USING users_staging AS source
        ON target.id = source.id
        WHEN MATCHED THEN
          UPDATE SET name = source.name, age = source.age
        WHEN NOT MATCHED THEN
          INSERT (name, email, age) VALUES (source.name, source.email, source.age)
        OUTPUT $action, INSERTED.name;
      `);
      
      expect(result.resultSets[0].rows.length).toBeGreaterThan(0);
      // Should have both UPDATE and INSERT actions
      const actions = result.resultSets[0].rows.map(row => row.$action);
      expect(actions).toContain('UPDATE');
      expect(actions).toContain('INSERT');
    });
  });

  describe('maxRows: T-SQL query shapes', () => {
    // Query shapes from issue #453: each used to be rewritten into a syntax
    // error, or to slip past max_rows entirely. (Plain SELECT and TOP n are in
    // the shared maxRows tests.)
    it.each([
      { sql: 'SELECT DISTINCT name FROM users ORDER BY name', maxRows: 2, rows: 2, truncated: true },
      { sql: 'SELECT ALL name FROM users ORDER BY name', maxRows: 2, rows: 2, truncated: true },
      // A parenthesised TOP (n) within the cap is respected.
      { sql: 'SELECT TOP (1) name FROM users ORDER BY id', maxRows: 3, rows: 1, truncated: undefined },
      { sql: 'SELECT name FROM users ORDER BY id OFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY', maxRows: 2, rows: 2, truncated: true },
      { sql: 'SELECT name FROM users ORDER BY id OFFSET 0 ROWS', maxRows: 2, rows: 2, truncated: true },
      // Capped by the rows it really returns: integer division ties every age
      // (all well below 1000) at 0, so TOP 1 WITH TIES returns the whole table.
      { sql: 'SELECT TOP 1 WITH TIES name FROM users ORDER BY ISNULL(age, 0) / 1000', maxRows: 2, rows: 2, truncated: true },
      { sql: 'SELECT TOP 100 PERCENT name FROM users', maxRows: 2, rows: 2, truncated: true },
    ])('should return $rows row(s), truncated: $truncated, for "$sql" under maxRows $maxRows', async ({ sql, maxRows, rows, truncated }) => {
      const result = await execute(sql, { maxRows });
      expect(result.resultSets[0].rows).toHaveLength(rows);
      expect(result.resultSets[0].truncated).toBe(truncated);
    });

    it('should respect an OFFSET ... FETCH that is within maxRows', async () => {
      const result = await execute(
        'SELECT name FROM users ORDER BY id OFFSET 1 ROWS FETCH NEXT 1 ROWS ONLY',
        { maxRows: 3 }
      );
      expect(result.resultSets[0].rows).toHaveLength(1);
      expect(result.resultSets[0].rows[0].name).toBe('Jane Smith');
      expect(result.resultSets[0].truncated).toBeUndefined();
    });

    it('should cap every statement of a batch inside the read-only rollback transaction', async () => {
      const result = await execute(
        'SELECT 1 AS a; SELECT name FROM users ORDER BY id;',
        { maxRows: 2, readonly: true }
      );
      expect(result.resultSets).toHaveLength(2);
      expect(result.resultSets[0].rows).toEqual([{ a: 1 }]);
      expect(result.resultSets[0].truncated).toBeUndefined();
      expect(result.resultSets[1].rows).toHaveLength(2);
      expect(result.resultSets[1].truncated).toBe(true);
    });

    it('should keep a batch delimiter out of a trailing line comment', async () => {
      // The splitter trims each segment, so the rejoined semicolon must not
      // land on the same line as a trailing `--` comment.
      const result = await execute(
        'SELECT 1 AS a -- note\n; SELECT name FROM users ORDER BY id;',
        { maxRows: 2 }
      );
      expect(result.resultSets).toHaveLength(2);
      expect(result.resultSets[0].rows).toEqual([{ a: 1 }]);
      expect(result.resultSets[1].rows).toHaveLength(2);
      expect(result.resultSets[1].truncated).toBe(true);
    });

    it('should not rewrite statements inside a stored procedure body', async () => {
      // Semicolons inside the body split like batch statements; the
      // rewrite must not reach them, or TOP would be stored in the
      // procedure's definition.
      await execute(
        'CREATE PROCEDURE dbo.max_rows_probe AS BEGIN SELECT 1 AS a; SELECT name FROM users ORDER BY id; END;',
        { maxRows: 2 }
      );
      try {
        const definition = await execute(
          "SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.max_rows_probe')) AS body"
        );
        expect(definition.resultSets[0].rows[0].body).not.toMatch(/\bTOP\b/i);

        // The procedure's output is still capped when it is executed.
        const result = await execute('EXEC dbo.max_rows_probe', { maxRows: 2 });
        expect(result.resultSets[0].rows).toEqual([{ a: 1 }]);
        expect(result.resultSets[1].rows).toHaveLength(2);
        expect(result.resultSets[1].truncated).toBe(true);
      } finally {
        await execute('DROP PROCEDURE dbo.max_rows_probe');
      }
    });
  });

  describe('Multi-statement result sets and messages', () => {
    it.each([{ readonly: false }, { readonly: true }])(
      'should return every result set from a multi-statement SELECT batch (readonly: $readonly)',
      async ({ readonly }) => {
        const result = await execute('SELECT 1 AS a; SELECT 2 AS b;', { readonly });

        // One resultSet per SELECT recordset, in order - not flattened together.
        expect(result.resultSets).toEqual([
          { rows: [{ a: 1 }], rowCount: 1 },
          { rows: [{ b: 2 }], rowCount: 1 },
        ]);
      }
    );

    it('should sum rowCount across a mixed write/read multi-statement batch', async () => {
      const result = await execute(
        `
        INSERT INTO users (name, email, age) VALUES ('Batch User', 'batch@sqlserver.com', 40);
        SELECT name, email FROM users WHERE email = 'batch@sqlserver.com';
        `
      );

      // One resultSet for the SELECT's recordset, plus a trailing write-only
      // resultSet for the INSERT (rowsAffected sums to 2: 1 insert + 1
      // select-rowcount; leftover after accounting for the select's row is 1).
      expect(result.resultSets).toEqual([
        { rows: [{ name: 'Batch User', email: 'batch@sqlserver.com' }], rowCount: 1 },
        { rows: [], rowCount: 1 },
      ]);
    });

    it('should capture PRINT output in messages', async () => {
      const result = await execute("PRINT 'hello from sql server'; SELECT 1 as value;");

      expect(result.resultSets[0].rows).toHaveLength(1);
      expect(result.resultSets[0].rows[0].value).toBe(1);
      expect(result.messages).toBeDefined();
      expect(result.messages!.length).toBeGreaterThan(0);
      expect(result.messages!.some(msg => msg.text === 'hello from sql server')).toBe(true);
    });

    it('should capture SET STATISTICS TIME output in messages', async () => {
      const result = await execute(
        'SET STATISTICS TIME ON; SELECT COUNT(*) as cnt FROM users; SET STATISTICS TIME OFF;'
      );

      expect(result.resultSets[0].rows).toHaveLength(1);
      expect(result.messages).toBeDefined();
      expect(result.messages!.length).toBeGreaterThan(0);
      // STATISTICS TIME emits messages containing "CPU time" and "elapsed time"
      const hasTimingMessage = result.messages!.some(
        msg => msg.text.includes('CPU time') || msg.text.includes('elapsed time')
      );
      expect(hasTimingMessage).toBe(true);
    });

    it('should not include messages field when no informational messages are emitted', async () => {
      const result = await execute('SELECT 1 as value');

      expect(result.resultSets[0].rows).toHaveLength(1);
      // messages should be undefined (not present) when no info messages were emitted
      expect(result.messages).toBeUndefined();
    });
  });
});
