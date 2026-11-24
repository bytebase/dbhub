import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { SQLiteConnector } from '../sqlite/index.js';
import { ConnectorManager } from '../manager.js';
import { IntegrationTestBase, type TestContainer, type DatabaseTestConfig } from './shared/integration-test-base.js';
import type { Connector } from '../interface.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

class SQLiteTestContainer implements TestContainer {
  constructor(private dbPath: string) {}
  
  getConnectionUri(): string {
    return `sqlite://${this.dbPath}`;
  }
  
  async stop(): Promise<void> {
    // Clean up the temporary database file
    if (this.dbPath !== ':memory:' && fs.existsSync(this.dbPath)) {
      try {
        // Add a small delay to ensure any file handles are fully released
        await new Promise(resolve => setTimeout(resolve, 10));
        fs.unlinkSync(this.dbPath);
      } catch (error) {
        // Log but don't throw - cleanup failures shouldn't break tests
        console.warn(`Failed to cleanup database file ${this.dbPath}:`, error);
      }
    }
  }
}

class SQLiteIntegrationTest extends IntegrationTestBase<SQLiteTestContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      expectedSchemas: ['main'], // SQLite uses 'main' as the default schema name
      expectedTables: ['users', 'orders'],
      supportsStoredProcedures: false, // SQLite doesn't support stored procedures
      beginTransaction: 'BEGIN TRANSACTION',
      readonlyWriteError: /readonly/i,
    };
    super(config);
  }

  async createContainer(): Promise<SQLiteTestContainer> {
    // Create a temporary database file
    const tempDir = os.tmpdir();
    const dbPath = path.join(tempDir, `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.db`);
    
    return new SQLiteTestContainer(dbPath);
  }

  createConnector(): Connector {
    return new SQLiteConnector();
  }

  async setupTestData(connector: Connector): Promise<void> {
    // Create users table
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        age INTEGER
      )
    `, {});

    // Create orders table
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        total DECIMAL(10,2),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
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
  }
}

const sqliteTest = new SQLiteIntegrationTest();

describe('SQLite Connector Integration Tests', () => {
  sqliteTest.registerLifecycle();

  sqliteTest.createCommonTests();
  sqliteTest.createOffsetCountLimitTests();

  describe('SQLite-specific Features', () => {
    it('should include virtual and stored generated columns in table schemas', async () => {
      await sqliteTest.connector.executeSQL(`
        CREATE TABLE "line items" (
          id INTEGER PRIMARY KEY,
          qty INTEGER NOT NULL DEFAULT 1,
          subtotal REAL GENERATED ALWAYS AS (qty * price) VIRTUAL NOT NULL,
          price REAL NOT NULL,
          stored_total REAL GENERATED ALWAYS AS (qty * price) STORED
        );
        INSERT INTO "line items" (qty, price) VALUES (3, 12.5);
      `, {});

      try {
        const result = await sqliteTest.connector.executeSQL('SELECT * FROM "line items"', {});
        expect(result.resultSets[0].rows[0].subtotal).toBe(37.5);
        expect(result.resultSets[0].rows[0].stored_total).toBe(37.5);

        const columns = await sqliteTest.connector.getTableSchema('line items', 'main');
        expect(columns.map(column => column.column_name)).toEqual([
          'id', 'qty', 'subtotal', 'price', 'stored_total',
        ]);
        expect(columns.find(column => column.column_name === 'subtotal')).toEqual({
          column_name: 'subtotal',
          data_type: 'REAL',
          is_nullable: 'NO',
          column_default: null,
          description: null,
        });
        expect(columns.find(column => column.column_name === 'stored_total')).toEqual({
          column_name: 'stored_total',
          data_type: 'REAL',
          is_nullable: 'YES',
          column_default: null,
          description: null,
        });
        expect(columns.find(column => column.column_name === 'qty')?.column_default).toBe('1');
      } finally {
        await sqliteTest.connector.executeSQL('DROP TABLE "line items"', {});
      }
    });

    it('should exclude hidden virtual-table columns from table schemas', async () => {
      await sqliteTest.connector.executeSQL(
        'CREATE VIRTUAL TABLE schema_fts USING fts5(title, content)', {}
      );

      try {
        const columns = await sqliteTest.connector.getTableSchema('schema_fts', 'main');
        expect(columns.map(column => column.column_name)).toEqual(['title', 'content']);
      } finally {
        await sqliteTest.connector.executeSQL('DROP TABLE schema_fts', {});
      }
    });

    it('should handle SQLite data types correctly', async () => {
      await sqliteTest.connector.executeSQL(`
        CREATE TABLE IF NOT EXISTS types_test (
          id INTEGER PRIMARY KEY,
          text_val TEXT,
          int_val INTEGER,
          real_val REAL,
          blob_val BLOB,
          null_val TEXT
        )
      `, {});

      await sqliteTest.connector.executeSQL(`
        INSERT INTO types_test (text_val, int_val, real_val, blob_val, null_val) 
        VALUES ('test string', 42, 3.14159, X'48656C6C6F', NULL)
      `, {});

      const result = await sqliteTest.connector.executeSQL(
        'SELECT * FROM types_test ORDER BY id DESC LIMIT 1', {}
      );
      
      expect(result.resultSets[0].rows).toHaveLength(1);
      expect(result.resultSets[0].rows[0].text_val).toBe('test string');
      expect(result.resultSets[0].rows[0].int_val).toBe(BigInt(42));
      expect(result.resultSets[0].rows[0].real_val).toBe(3.14159);
      expect(result.resultSets[0].rows[0].null_val).toBeNull();
    });

    it('should return rows for value-reporting pragmas that no keyword list names', async () => {
      const version = await sqliteTest.connector.executeSQL('PRAGMA user_version', {});
      expect(version.resultSets[0].rows).toHaveLength(1);
      expect(Number(version.resultSets[0].rows[0].user_version)).toBe(0);

      // table_xinfo is what the connector's own getTableSchema reads
      const xinfo = await sqliteTest.connector.executeSQL('PRAGMA table_xinfo(users)', {});
      expect(xinfo.resultSets[0].rows.map(row => row.name)).toContain('email');

      // ...and in a batch, alongside a pragma that reports nothing
      const batch = await sqliteTest.connector.executeSQL(
        'PRAGMA foreign_keys = ON; PRAGMA foreign_keys; PRAGMA database_list',
        {}
      );
      expect(batch.resultSets[0].rows).toEqual([]);
      expect(Number(batch.resultSets[1].rows[0].foreign_keys)).toBe(1);
      expect(batch.resultSets[2].rows[0].name).toBe('main');
    });

    describe('RETURNING clauses', () => {
      const countRows = async (where: string): Promise<number> => {
        const result = await sqliteTest.connector.executeSQL(
          `SELECT COUNT(*) AS c FROM users WHERE ${where}`,
          {}
        );
        return Number(result.resultSets[0].rows[0].c);
      };

      // Runs the assertions against whatever runtime the connector sees; each
      // write must happen exactly once and hand back its RETURNING rows.
      const expectReturningRows = async (tag: string) => {
        const single = await sqliteTest.connector.executeSQL(
          `INSERT INTO users (name, email, age) VALUES ('ret-${tag}', 'ret-${tag}@example.com', 41) RETURNING name, age`,
          {}
        );
        expect(single.resultSets).toHaveLength(1);
        expect(single.resultSets[0].rows).toHaveLength(1);
        expect(single.resultSets[0].rows[0].name).toBe(`ret-${tag}`);
        expect(Number(single.resultSets[0].rows[0].age)).toBe(41);
        expect(single.resultSets[0].rowCount).toBe(1);
        expect(await countRows(`email = 'ret-${tag}@example.com'`)).toBe(1);

        const batch = await sqliteTest.connector.executeSQL(
          `INSERT INTO users (name, email, age) VALUES ('batch-${tag}', 'batch-${tag}@example.com', 20) RETURNING name;
           UPDATE users SET age = age + 1 WHERE email = 'batch-${tag}@example.com' RETURNING age;
           DELETE FROM users WHERE email = 'ret-${tag}@example.com' RETURNING email;
           UPDATE users SET age = age + 1 WHERE email = 'batch-${tag}@example.com'`,
          {}
        );
        expect(batch.resultSets).toHaveLength(4);
        expect(batch.resultSets[0].rows.map((row) => row.name)).toEqual([`batch-${tag}`]);
        // 20 + 1: the UPDATE ran once before its row was read back
        expect(batch.resultSets[1].rows.map((row) => Number(row.age))).toEqual([21]);
        expect(batch.resultSets[2].rows.map((row) => row.email)).toEqual([`ret-${tag}@example.com`]);
        // No RETURNING: no rows, and rowCount is the number of rows changed
        expect(batch.resultSets[3].rows).toEqual([]);
        expect(batch.resultSets[3].rowCount).toBe(1);

        expect(await countRows(`email = 'ret-${tag}@example.com'`)).toBe(0);
        expect(await countRows(`email = 'batch-${tag}@example.com'`)).toBe(1);
        // Two UPDATEs, each applied exactly once
        const age = await sqliteTest.connector.executeSQL(
          `SELECT age FROM users WHERE email = 'batch-${tag}@example.com'`,
          {}
        );
        expect(Number(age.resultSets[0].rows[0].age)).toBe(22);
      };

      it('should return the rows of INSERT / UPDATE / DELETE ... RETURNING, single and batched', async () => {
        await expectReturningRows('native');
      });

      it('should do the same on a runtime without StatementSync.columns() (Node 22.5 - 22.16)', async () => {
        // Hide columns() the way an older runtime lacks it, so both
        // returnsRows() and readRows() take their fallback paths.
        const statement = (sqliteTest.connector as any).db.prepare('SELECT 1');
        const prototype = Object.getPrototypeOf(statement);
        const original = Object.getOwnPropertyDescriptor(prototype, 'columns');
        Object.defineProperty(prototype, 'columns', { value: undefined, configurable: true, writable: true });
        try {
          expect(typeof (sqliteTest.connector as any).db.prepare('SELECT 1').columns).toBe('undefined');
          await expectReturningRows('fallback');

          // A word inside a string, comment or quoted identifier is not the keyword
          const plain = await sqliteTest.connector.executeSQL(
            `UPDATE users SET name = 'returning' WHERE email = 'batch-fallback@example.com' -- returning`,
            {}
          );
          expect(plain.resultSets[0].rows).toEqual([]);
          expect(plain.resultSets[0].rowCount).toBe(1);
        } finally {
          if (original) {
            Object.defineProperty(prototype, 'columns', original);
          } else {
            delete prototype.columns;
          }
        }
      });
    });

    it('should execute multi-statement batches in source order', async () => {
      await sqliteTest.connector.executeSQL(`
        CREATE TABLE order_check (a INTEGER);
        INSERT INTO order_check VALUES (1), (2), (3);
      `, {});

      const result = await sqliteTest.connector.executeSQL(`
        SELECT a AS before_delete FROM order_check ORDER BY a;
        DELETE FROM order_check;
        SELECT COUNT(*) AS after_delete FROM order_check;
      `, { maxRows: 2 });

      expect(result.resultSets.map((rs) => rs.sql)).toEqual([
        'SELECT a AS before_delete FROM order_check ORDER BY a',
        'DELETE FROM order_check',
        'SELECT COUNT(*) AS after_delete FROM order_check',
      ]);
      // maxRows caps the SELECT (which still reports the statement as it was
      // written, above) and leaves the write that shares its batch alone
      expect(result.resultSets[0].rows.map((row) => Number(row.before_delete))).toEqual([1, 2]);
      expect(result.resultSets[0].truncated).toBe(true);
      expect(result.resultSets[1].rowCount).toBe(3);
      expect(Number(result.resultSets[2].rows[0].after_delete)).toBe(0);

      await sqliteTest.connector.executeSQL('DROP TABLE order_check', {});
    });

    it('should return rows and apply maxRows to a query introduced by a comment', async () => {
      // SQLite picks all() vs run() by leading keyword; a leading comment
      // used to send a SELECT down the run() path and discard its rows.
      const result = await sqliteTest.connector.executeSQL(
        '-- dbhub attribution tag\nSELECT name FROM users ORDER BY name',
        { maxRows: 2 }
      );

      expect(result.resultSets[0].rows).toHaveLength(2);
      expect(result.resultSets[0].truncated).toBe(true);
    });

    it('should apply maxRows to LIMIT -1 OFFSET n, the only way SQLite skips rows without a cap', async () => {
      const all = await sqliteTest.connector.executeSQL('SELECT name FROM users ORDER BY name', {});
      const skipped = all.resultSets[0].rows.length - 1;

      const result = await sqliteTest.connector.executeSQL(
        'SELECT name FROM users ORDER BY name LIMIT -1 OFFSET 1',
        { maxRows: 2 }
      );

      expect(result.resultSets[0].rows).toHaveLength(Math.min(2, skipped));
      expect(result.resultSets[0].truncated).toBe(skipped > 2);
    });

  });

  describe('DSN Path Parsing', () => {
    describe('relative paths', () => {
      // Run from a scratch directory that is not the filesystem root, so a path
      // that is wrongly rooted (the old behaviour) cannot be mistaken for one
      // resolved against the working directory.
      const originalCwd = process.cwd();
      let workDir: string;

      beforeEach(() => {
        workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub-sqlite-rel-')));
        fs.mkdirSync(path.join(workDir, 'data'));
        process.chdir(workDir);
      });

      afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(workDir, { recursive: true, force: true });
      });

      it.each([
        ['sqlite:///./shop.db', 'shop.db'],
        ['sqlite://./shop.db', 'shop.db'],
        ['sqlite://shop.db', 'shop.db'],
        ['sqlite://data/shop.db', path.join('data', 'shop.db')],
        ['sqlite:///./data/shop.db', path.join('data', 'shop.db')],
      ])('should open %s inside the working directory', async (dsn, relativePath) => {
        const expected = path.join(workDir, relativePath);
        const connector = new SQLiteConnector();

        expect((await connector.dsnParser.parse(dsn)).dbPath).toBe(expected);

        await connector.connect(dsn);
        try {
          await connector.executeSQL('CREATE TABLE test (id INTEGER PRIMARY KEY)', {});
        } finally {
          await connector.disconnect();
        }
        expect(fs.existsSync(expected)).toBe(true);
      });
    });

    describe('opening a file that is not there', () => {
      let errorSpy: MockInstance<typeof console.error>;

      beforeEach(() => {
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      });

      afterEach(() => {
        errorSpy.mockRestore();
      });

      it('should name the resolved path and the missing directory', async () => {
        const missingDir = path.join(os.tmpdir(), `dbhub-missing-${Date.now()}`);
        const dbPath = path.join(missingDir, 'shop.db');

        const failure = new SQLiteConnector().connect(`sqlite://${dbPath}`);

        // SQLite on its own says only "unable to open database file"
        await expect(failure).rejects.toThrow(
          `Unable to open SQLite database file '${dbPath}': directory '${missingDir}' does not exist`
        );
        await expect(failure).rejects.toThrow('sqlite:///./database.db for a relative path');
      });

      it('should say so when it creates a new database file', async () => {
        const dbPath = path.join(os.tmpdir(), `dbhub-created-${Date.now()}.db`);
        const connector = new SQLiteConnector();

        try {
          await connector.connect(`sqlite://${dbPath}`);
          expect(errorSpy).toHaveBeenCalledWith(
            `Warning: SQLite database file '${dbPath}' did not exist; created a new, empty database.`
          );

          // Reconnecting to the file that now exists is silent
          await connector.disconnect();
          errorSpy.mockClear();
          await connector.connect(`sqlite://${dbPath}`);
          expect(errorSpy).not.toHaveBeenCalled();
        } finally {
          await connector.disconnect();
          fs.rmSync(dbPath, { force: true });
        }
      });

      it('should not create the file when it is required to exist', async () => {
        const dbPath = path.join(os.tmpdir(), `dbhub-required-${Date.now()}.db`);

        await expect(
          new SQLiteConnector().connect(`sqlite://${dbPath}`, undefined, { requireExistingFile: true })
        ).rejects.toThrow(
          `Unable to open SQLite database file '${dbPath}': the file does not exist. ` +
            'It was not created because no tool on this source can write to it.'
        );
        expect(fs.existsSync(dbPath)).toBe(false);
      });

      it('should open an existing file that is required to exist', async () => {
        const dbPath = path.join(os.tmpdir(), `dbhub-required-${Date.now()}.db`);
        fs.writeFileSync(dbPath, '');
        const connector = new SQLiteConnector();

        try {
          await connector.connect(`sqlite://${dbPath}`, undefined, { requireExistingFile: true });
          expect(errorSpy).not.toHaveBeenCalled();
        } finally {
          await connector.disconnect();
          fs.rmSync(dbPath, { force: true });
        }
      });

      it('should not create the file for a source whose tools are all read-only', async () => {
        const dbPath = path.join(os.tmpdir(), `dbhub-readonly-source-${Date.now()}.db`);
        const manager = new ConnectorManager();

        try {
          await expect(
            manager.connectWithSources([
              { id: 'shop', type: 'sqlite', dsn: `sqlite://${dbPath}`, tools_read_only: true },
            ])
          ).rejects.toThrow('the file does not exist');
          expect(fs.existsSync(dbPath)).toBe(false);
        } finally {
          await manager.disconnect();
          fs.rmSync(dbPath, { force: true });
        }
      });

      it('should stay silent for an in-memory database', async () => {
        const connector = new SQLiteConnector();
        await connector.connect('sqlite:///:memory:');
        await connector.disconnect();

        expect(errorSpy).not.toHaveBeenCalled();
      });
    });

    it('should reject a DSN that names no file instead of opening a temporary database', async () => {
      await expect(new SQLiteConnector().connect('sqlite://')).rejects.toThrow(
        'does not name a database file'
      );
    });

    // Issue #137: a drive letter after three slashes is a Windows path, on any
    // platform. sqlite-dsn.test.ts covers the upper-case C: spellings.
    it.each(['c:/temp/test.db', 'D:/path/to/db.db'])(
      'should parse the Windows drive letter path %s as written',
      async (dbPath) => {
        const parsed = await new SQLiteConnector().dsnParser.parse(`sqlite:///${dbPath}`);
        expect(parsed.dbPath).toBe(dbPath);
      }
    );

  });

  describe('SDK-Level Readonly Mode Tests', () => {
    it('should open file-based database in readonly mode', async () => {
      // Now open the same database in readonly mode using ConnectorConfig
      const readonlyConnector = new SQLiteConnector();
      await readonlyConnector.connect(sqliteTest.connectionString, undefined, { readonly: true });

      try {
        // Should be able to read from the main tables
        const result = await readonlyConnector.executeSQL('SELECT * FROM users LIMIT 1', {});
        expect(result.resultSets[0].rows).toHaveLength(1);

        // Should NOT be able to write data (SDK-level enforcement)
        await expect(
          readonlyConnector.executeSQL("INSERT INTO users (name, email) VALUES ('fail', 'fail@test.com')", {})
        ).rejects.toThrow(/readonly/);
      } finally {
        await readonlyConnector.disconnect();
      }
    });

    it('should allow writes to :memory: database even with readonly flag', async () => {
      const connector = new SQLiteConnector();

      // Connect to :memory: with readonly flag
      // Should succeed because we skip readonly for :memory: databases
      await connector.connect('sqlite:///:memory:', undefined, { readonly: true });

      // Should be able to create tables and insert data
      await connector.executeSQL('CREATE TABLE test (id INTEGER)', {});
      await connector.executeSQL('INSERT INTO test VALUES (1)', {});

      const result = await connector.executeSQL('SELECT * FROM test', {});
      expect(result.resultSets[0].rows).toHaveLength(1);
      expect(result.resultSets[0].rows[0].id).toBe(BigInt(1));

      await connector.disconnect();
    });

    it('should fail to open non-existent file in readonly mode, naming the file', async () => {
      const connector = new SQLiteConnector();
      const nonExistentPath = path.join(os.tmpdir(), `nonexistent_${Date.now()}.db`);
      const dsn = `sqlite://${nonExistentPath}`;

      // Should fail because file doesn't exist and we're in readonly mode
      await expect(
        connector.connect(dsn, undefined, { readonly: true })
      ).rejects.toThrow(
        `Unable to open SQLite database file '${nonExistentPath}': the file does not exist`
      );
      expect(fs.existsSync(nonExistentPath)).toBe(false);
    });
  });

  describe('Per-tool readonly engine backstop: PRAGMA query_only', () => {
    // The connection itself is writable (shared by read-only and writable tools);
    // read-only enforcement is applied per execution via PRAGMA query_only.
    it('should block a write-effecting PRAGMA when options.readonly is set', async () => {
      // query_only makes the engine reject the header write; the classifier would
      // also reject the assignment form, so this is defense in depth.
      await expect(
        sqliteTest.connector.executeSQL('PRAGMA user_version = 1337', { readonly: true })
      ).rejects.toThrow(/readonly|query_only/i);
    });

    it('should allow read-only PRAGMA and SELECT when options.readonly is set', async () => {
      const select = await sqliteTest.connector.executeSQL('SELECT 1 AS one', { readonly: true });
      expect(Number(select.resultSets[0].rows[0].one)).toBe(1);

      const pragma = await sqliteTest.connector.executeSQL('PRAGMA table_info(users)', { readonly: true });
      expect(pragma.resultSets[0].rows.length).toBeGreaterThan(0);
    });

    it('should not let an in-batch query_only toggle disable the backstop', async () => {
      // Even if the classifier were skipped, the engine re-asserts query_only=ON
      // before each statement, so a mid-batch toggle cannot enable the later INSERT.
      await expect(
        sqliteTest.connector.executeSQL(
          "PRAGMA query_only = OFF; INSERT INTO users (name, email) VALUES ('bypass', 'bypass@test.com')",
          { readonly: true }
        )
      ).rejects.toThrow(/readonly|query_only/i);

      const check = await sqliteTest.connector.executeSQL(
        "SELECT COUNT(*) AS c FROM users WHERE email = 'bypass@test.com'",
        {}
      );
      expect(Number(check.resultSets[0].rows[0].c)).toBe(0);
    });
  });
});