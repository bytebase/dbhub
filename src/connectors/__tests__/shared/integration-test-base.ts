import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Connector } from '../../interface.js';

export interface DatabaseTestConfig {
  expectedSchemas: string[];
  expectedTables: string[];
  expectedTestSchemaTable?: string;
  testSchema?: string;
  supportsStoredProcedures?: boolean;
  expectedStoredProcedures?: string[];
}

export interface TestContainer {
  getConnectionUri(): string;
  stop(): Promise<void>;
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
    if (this.connector) {
      await this.connector.disconnect();
    }
    if (this.container) {
      await this.container.stop();
    }
  }

  /**
   * Common test suite that can be reused across different database types
   */
  createTestSuite(suiteName: string): void {
    describe(suiteName, () => {
      beforeAll(async () => {
        await this.setup();
      }, 120000);

      afterAll(async () => {
        await this.cleanup();
      });

      this.createConnectionTests();
      this.createSchemaTests();
      this.createTableTests();
      this.createSQLExecutionTests();
      
      if (this.config.supportsStoredProcedures) {
        this.createStoredProcedureTests();
      }
      
      this.createErrorHandlingTests();
    });
  }

  createConnectionTests(): void {
    describe('Connection', () => {
      it('should connect successfully to database container', async () => {
        expect(this.connector).toBeDefined();
      });

      it('should parse DSN correctly', async () => {
        const sampleDSN = this.connector.dsnParser.getSampleDSN();
        expect(sampleDSN).toContain('://');
        expect(this.connector.dsnParser.isValidDSN(sampleDSN)).toBe(true);
      });

      it('should validate DSN format', () => {
        const sampleDSN = this.connector.dsnParser.getSampleDSN();
        expect(this.connector.dsnParser.isValidDSN(sampleDSN)).toBe(true);
        expect(this.connector.dsnParser.isValidDSN('invalid-dsn')).toBe(false);
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

      it('should check if table exists', async () => {
        const firstTable = this.config.expectedTables[0];
        expect(await this.connector.tableExists(firstTable)).toBe(true);
        expect(await this.connector.tableExists('nonexistent_table')).toBe(false);
        
        if (this.config.testSchema && this.config.expectedTestSchemaTable) {
          expect(await this.connector.tableExists(this.config.expectedTestSchemaTable, this.config.testSchema)).toBe(true);
          expect(await this.connector.tableExists(this.config.expectedTestSchemaTable, 'public')).toBe(false);
        }
      });
    });
  }

  createTableTests(): void {
    describe('Table Schema Operations', () => {
      it('should get table schema for users table', async () => {
        const schema = await this.connector.getTableSchema('users');
        expect(schema.length).toBeGreaterThan(0);
        
        const idColumn = schema.find(col => col.column_name === 'id');
        expect(idColumn).toBeDefined();
        expect(idColumn?.is_nullable).toBe('NO');
        
        const nameColumn = schema.find(col => col.column_name === 'name');
        expect(nameColumn).toBeDefined();
      });

      it('should get table indexes', async () => {
        const indexes = await this.connector.getTableIndexes('users');
        expect(indexes.length).toBeGreaterThan(0);
        
        const primaryIndex = indexes.find(idx => idx.is_primary);
        expect(primaryIndex).toBeDefined();
        expect(primaryIndex?.column_names).toContain('id');
        
        // Some databases automatically create unique indexes, others handle unique constraints differently
        // We'll just verify we got at least the primary key index
        expect(indexes.length).toBeGreaterThanOrEqual(1);
      });
    });
  }

  createSQLExecutionTests(): void {
    describe('SQL Execution', () => {
      it('should execute simple SELECT query', async () => {
        const result = await this.connector.executeSQL('SELECT COUNT(*) as count FROM users', {});
        expect(result.rows).toHaveLength(1);
        expect(Number(result.rows[0].count)).toBeGreaterThanOrEqual(3);
      });

      it('should execute INSERT and SELECT', async () => {
        const insertResult = await this.connector.executeSQL(
          "INSERT INTO users (name, email, age) VALUES ('Test User', 'test@example.com', 25)", {}
        );
        expect(insertResult).toBeDefined();
        
        const selectResult = await this.connector.executeSQL(
          "SELECT * FROM users WHERE email = 'test@example.com'", {}
        );
        expect(selectResult.rows).toHaveLength(1);
        expect(selectResult.rows[0].name).toBe('Test User');
        expect(Number(selectResult.rows[0].age)).toBe(25);
      });

      it('should handle complex queries with joins', async () => {
        const result = await this.connector.executeSQL(`
          SELECT u.name, COUNT(o.id) as order_count
          FROM users u
          LEFT JOIN orders o ON u.id = o.user_id
          GROUP BY u.id, u.name
          HAVING COUNT(o.id) > 0
          ORDER BY order_count DESC
        `, {});
        
        expect(result.rows.length).toBeGreaterThan(0);
        expect(result.rows[0]).toHaveProperty('name');
        expect(result.rows[0]).toHaveProperty('order_count');
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
          const procedureName = this.config.expectedStoredProcedures[0];
          const procedure = await this.connector.getStoredProcedureDetail(procedureName);
          expect(procedure.procedure_name).toBe(procedureName);
          expect(procedure.procedure_type).toMatch(/function|procedure/);
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
    });
  }
}