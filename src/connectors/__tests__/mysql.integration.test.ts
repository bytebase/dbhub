import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import { MySQLConnector } from '../mysql/index.js';
import { IntegrationTestBase, type TestContainer, type DatabaseTestConfig } from './shared/integration-test-base.js';
import type { Connector } from '../interface.js';

class MySQLTestContainer implements TestContainer {
  constructor(private container: StartedMySqlContainer) {}
  
  getConnectionUri(): string {
    return this.container.getConnectionUri();
  }
  
  async stop(): Promise<void> {
    await this.container.stop();
  }
}

class MySQLIntegrationTest extends IntegrationTestBase<MySQLTestContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      expectedSchemas: ['testdb', 'information_schema'],
      expectedTables: ['users', 'orders', 'products'],
      supportsStoredProcedures: false // Disabled due to container privilege restrictions
    };
    super(config);
  }

  async createContainer(): Promise<MySQLTestContainer> {
    const container = await new MySqlContainer('mysql:8.0')
      .withDatabase('testdb')
      .withRootPassword('rootpass')
      .start();
    
    return new MySQLTestContainer(container);
  }

  createConnector(): Connector {
    return new MySQLConnector();
  }

  createSSLTests(): void {
    describe('SSL Connection Tests', () => {
      it('should handle SSL mode disable connection', async () => {
        const baseUri = this.connectionString;
        const sslDisabledUri = baseUri.includes('?') ? 
          `${baseUri}&sslmode=disable` : 
          `${baseUri}?sslmode=disable`;
        
        const sslDisabledConnector = new MySQLConnector();
        
        // Should connect successfully with sslmode=disable
        await expect(sslDisabledConnector.connect(sslDisabledUri)).resolves.not.toThrow();
        
        // Check SSL status - cipher should be empty when SSL is disabled
        const result = await sslDisabledConnector.executeSQL("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].Variable_name).toBe('Ssl_cipher');
        expect(result.rows[0].Value).toBe('');
        
        await sslDisabledConnector.disconnect();
      });

      it('should handle SSL mode require connection', async () => {
        const baseUri = this.connectionString;
        const sslRequiredUri = baseUri.includes('?') ? 
          `${baseUri}&sslmode=require` : 
          `${baseUri}?sslmode=require`;
        
        const sslRequiredConnector = new MySQLConnector();
        
        // In test containers, SSL may not be supported, so we expect either success or SSL not supported error
        try {
          await sslRequiredConnector.connect(sslRequiredUri);
          
          // If connection succeeds, check SSL status - cipher should be non-empty when SSL is enabled
          const result = await sslRequiredConnector.executeSQL("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
          expect(result.rows).toHaveLength(1);
          expect(result.rows[0].Variable_name).toBe('Ssl_cipher');
          expect(result.rows[0].Value).not.toBe('');
          expect(result.rows[0].Value).toBeTruthy();
          
          await sslRequiredConnector.disconnect();
        } catch (error) {
          // If SSL is not supported by the test container, that's expected
          expect(error instanceof Error).toBe(true);
          expect((error as Error).message).toMatch(/SSL|does not support SSL/);
        }
      });
    });
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
    `);

    // Create orders table
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        total DECIMAL(10,2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Create products table in main database
    await connector.executeSQL(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10,2)
      )
    `);

    // Insert test data
    await connector.executeSQL(`
      INSERT IGNORE INTO users (name, email, age) VALUES 
      ('John Doe', 'john@example.com', 30),
      ('Jane Smith', 'jane@example.com', 25),
      ('Bob Johnson', 'bob@example.com', 35)
    `);

    await connector.executeSQL(`
      INSERT IGNORE INTO orders (user_id, total) VALUES 
      (1, 99.99),
      (1, 149.50),
      (2, 75.25)
    `);

    await connector.executeSQL(`
      INSERT IGNORE INTO products (name, price) VALUES 
      ('Widget A', 19.99),
      ('Widget B', 29.99)
    `);

    // Note: Stored procedures/functions are skipped in tests due to container privilege restrictions
  }
}

// Create the test suite
const mysqlTest = new MySQLIntegrationTest();

describe('MySQL Connector Integration Tests', () => {
  beforeAll(async () => {
    await mysqlTest.setup();
  }, 120000);

  afterAll(async () => {
    await mysqlTest.cleanup();
  });

  // Include all common tests
  mysqlTest.createConnectionTests();
  mysqlTest.createSchemaTests();
  mysqlTest.createTableTests();
  mysqlTest.createSQLExecutionTests();
  if (mysqlTest.config.supportsStoredProcedures) {
    mysqlTest.createStoredProcedureTests();
  }
  mysqlTest.createErrorHandlingTests();
  mysqlTest.createSSLTests();

  describe('MySQL-specific Features', () => {
    it('should execute multiple statements with native support', async () => {
      // First insert the test data
      await mysqlTest.connector.executeSQL(`
        INSERT INTO users (name, email, age) VALUES ('Multi User 1', 'multi1@example.com', 30);
        INSERT INTO users (name, email, age) VALUES ('Multi User 2', 'multi2@example.com', 35);
      `);
      
      // Then check the count
      const result = await mysqlTest.connector.executeSQL(
        "SELECT COUNT(*) as total FROM users WHERE email LIKE 'multi%'"
      );
      
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0].total)).toBe(2);
    });

    it('should handle MySQL-specific data types', async () => {
      await mysqlTest.connector.executeSQL(`
        CREATE TABLE IF NOT EXISTS mysql_types_test (
          id INT AUTO_INCREMENT PRIMARY KEY,
          json_data JSON,
          timestamp_val TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          enum_val ENUM('small', 'medium', 'large') DEFAULT 'medium'
        )
      `);

      await mysqlTest.connector.executeSQL(`
        INSERT INTO mysql_types_test (json_data, enum_val) 
        VALUES ('{"key": "value"}', 'large')
      `);

      const result = await mysqlTest.connector.executeSQL(
        'SELECT * FROM mysql_types_test WHERE id = LAST_INSERT_ID()'
      );
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].enum_val).toBe('large');
      expect(result.rows[0].json_data).toBeDefined();
    });

    it('should handle MySQL auto-increment properly', async () => {
      const insertResult = await mysqlTest.connector.executeSQL(
        "INSERT INTO users (name, email, age) VALUES ('Auto Inc Test', 'autoinc@example.com', 40)"
      );
      
      expect(insertResult).toBeDefined();
      
      const selectResult = await mysqlTest.connector.executeSQL(
        'SELECT LAST_INSERT_ID() as last_id'
      );
      
      expect(selectResult.rows).toHaveLength(1);
      expect(Number(selectResult.rows[0].last_id)).toBeGreaterThan(0);
    });

    it('should work with MySQL-specific functions', async () => {
      const result = await mysqlTest.connector.executeSQL(`
        SELECT 
          VERSION() as mysql_version,
          DATABASE() as current_db,
          USER() as current_user_info,
          NOW() as timestamp_val
      `);
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].mysql_version).toBeDefined();
      expect(result.rows[0].current_db).toBe('testdb');
      expect(result.rows[0].current_user_info).toBeDefined();
      expect(result.rows[0].timestamp_val).toBeDefined();
    });

    it('should handle MySQL transactions correctly', async () => {
      // Test explicit transaction
      await mysqlTest.connector.executeSQL(`
        START TRANSACTION;
        INSERT INTO users (name, email, age) VALUES ('Transaction Test 1', 'trans1@example.com', 45);
        INSERT INTO users (name, email, age) VALUES ('Transaction Test 2', 'trans2@example.com', 50);
        COMMIT;
      `);
      
      const result = await mysqlTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email LIKE 'trans%@example.com'"
      );
      expect(Number(result.rows[0].count)).toBe(2);
    });

    it('should handle MySQL rollback correctly', async () => {
      // Get initial count
      const beforeResult = await mysqlTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email = 'rollback@example.com'"
      );
      const beforeCount = Number(beforeResult.rows[0].count);
      
      // Test rollback
      await mysqlTest.connector.executeSQL(`
        START TRANSACTION;
        INSERT INTO users (name, email, age) VALUES ('Rollback Test', 'rollback@example.com', 55);
        ROLLBACK;
      `);
      
      const afterResult = await mysqlTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email = 'rollback@example.com'"
      );
      const afterCount = Number(afterResult.rows[0].count);
      
      expect(afterCount).toBe(beforeCount);
    });
  });
});