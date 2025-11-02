import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MariaDbContainer, StartedMariaDbContainer } from '@testcontainers/mariadb';
import { MariaDBConnector } from '../mariadb/index.js';
import { IntegrationTestBase, type TestContainer, type DatabaseTestConfig } from './shared/integration-test-base.js';
import type { Connector } from '../interface.js';

class MariaDBTestContainer implements TestContainer {
  constructor(private container: StartedMariaDbContainer) {}
  
  getConnectionUri(): string {
    return this.container.getConnectionUri();
  }
  
  async stop(): Promise<void> {
    await this.container.stop();
  }
}

class MariaDBIntegrationTest extends IntegrationTestBase<MariaDBTestContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      expectedSchemas: ['testdb', 'information_schema'],
      expectedTables: ['users', 'orders', 'products'],
      supportsStoredProcedures: false // Disabled due to container privilege restrictions
    };
    super(config);
  }

  async createContainer(): Promise<MariaDBTestContainer> {
    const container = await new MariaDbContainer('mariadb:10.11')
      .withDatabase('testdb')
      .withRootPassword('rootpass')
      .start();
    
    return new MariaDBTestContainer(container);
  }

  createConnector(): Connector {
    return new MariaDBConnector();
  }

  createSSLTests(): void {
    describe('SSL Connection Tests', () => {
      it('should handle SSL mode disable connection', async () => {
        const baseUri = this.connectionString;
        const sslDisabledUri = baseUri.includes('?') ? 
          `${baseUri}&sslmode=disable` : 
          `${baseUri}?sslmode=disable`;
        
        const sslDisabledConnector = new MariaDBConnector();
        
        // Should connect successfully with sslmode=disable
        await expect(sslDisabledConnector.connect(sslDisabledUri)).resolves.not.toThrow();
        
        // Check SSL status - cipher should be empty when SSL is disabled
        const result = await sslDisabledConnector.executeSQL("SHOW SESSION STATUS LIKE 'Ssl_cipher'", {});
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
        
        const sslRequiredConnector = new MariaDBConnector();
        
        // In test containers, SSL may not be supported, so we expect either success or SSL not supported error
        try {
          // Add our own timeout to prevent test hanging
          const connectionPromise = sslRequiredConnector.connect(sslRequiredUri);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout')), 3000)
          );
          
          await Promise.race([connectionPromise, timeoutPromise]);
          
          // If connection succeeds, check SSL status - cipher should be non-empty when SSL is enabled
          const result = await sslRequiredConnector.executeSQL("SHOW SESSION STATUS LIKE 'Ssl_cipher'", {});
          expect(result.rows).toHaveLength(1);
          expect(result.rows[0].Variable_name).toBe('Ssl_cipher');
          expect(result.rows[0].Value).not.toBe('');
          expect(result.rows[0].Value).toBeTruthy();
          
          await sslRequiredConnector.disconnect();
        } catch (error) {
          // If SSL is not supported by the test container, that's expected
          expect(error instanceof Error).toBe(true);
          expect((error as Error).message).toMatch(/SSL|does not support SSL|timeout|ETIMEDOUT|Connection timeout/);
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
}

// Create the test suite
const mariadbTest = new MariaDBIntegrationTest();

describe('MariaDB Connector Integration Tests', () => {
  beforeAll(async () => {
    await mariadbTest.setup();
  }, 120000);

  afterAll(async () => {
    await mariadbTest.cleanup();
  });

  // Include all common tests
  mariadbTest.createConnectionTests();
  mariadbTest.createSchemaTests();
  mariadbTest.createTableTests();
  mariadbTest.createSQLExecutionTests();
  if (mariadbTest.config.supportsStoredProcedures) {
    mariadbTest.createStoredProcedureTests();
  }
  mariadbTest.createErrorHandlingTests();
  mariadbTest.createSSLTests();

  describe('MariaDB-specific Features', () => {
    it('should execute multiple statements with native support', async () => {
      // First insert the test data
      await mariadbTest.connector.executeSQL(`
        INSERT INTO users (name, email, age) VALUES ('Multi User 1', 'multi1@example.com', 30);
        INSERT INTO users (name, email, age) VALUES ('Multi User 2', 'multi2@example.com', 35);
      `, {});
      
      // Then check the count
      const result = await mariadbTest.connector.executeSQL(
        "SELECT COUNT(*) as total FROM users WHERE email LIKE 'multi%'",
        {}
      );
      
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0].total)).toBe(2);
    });

    it('should handle MariaDB-specific data types', async () => {
      await mariadbTest.connector.executeSQL(`
        CREATE TABLE IF NOT EXISTS mariadb_types_test (
          id INT AUTO_INCREMENT PRIMARY KEY,
          json_data JSON,
          timestamp_val TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          enum_val ENUM('small', 'medium', 'large') DEFAULT 'medium',
          bit_val BIT(8) DEFAULT b'00000001'
        )
      `, {});

      await mariadbTest.connector.executeSQL(`
        INSERT INTO mariadb_types_test (json_data, enum_val, bit_val) 
        VALUES ('{"key": "value"}', 'large', b'11110000')
      `, {});

      // Use a different approach to get the inserted row
      const result = await mariadbTest.connector.executeSQL(
        "SELECT * FROM mariadb_types_test WHERE enum_val = 'large' ORDER BY id DESC LIMIT 1",
        {}
      );
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].enum_val).toBe('large');
      expect(result.rows[0].json_data).toBeDefined();
      expect(result.rows[0].bit_val).toBeDefined();
    });

    it('should handle MariaDB auto-increment properly', async () => {
      // Execute INSERT and SELECT LAST_INSERT_ID() in a single call to ensure same connection
      const result = await mariadbTest.connector.executeSQL(
        "INSERT INTO users (name, email, age) VALUES ('Auto Inc Test', 'autoinc@example.com', 40); SELECT LAST_INSERT_ID() as last_id",
        {}
      );

      expect(result).toBeDefined();
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0].last_id)).toBeGreaterThan(0);
    });

    it('should work with MariaDB-specific functions', async () => {
      const result = await mariadbTest.connector.executeSQL(`
        SELECT 
          VERSION() as mariadb_version,
          DATABASE() as current_db,
          USER() as current_user_info,
          NOW() as timestamp_val
      `, {});
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].mariadb_version).toContain('MariaDB');
      expect(result.rows[0].current_db).toBe('testdb');
      expect(result.rows[0].current_user_info).toBeDefined();
      expect(result.rows[0].timestamp_val).toBeDefined();
    });

    it('should handle MariaDB transactions correctly', async () => {
      // Test explicit transaction
      await mariadbTest.connector.executeSQL(`
        START TRANSACTION;
        INSERT INTO users (name, email, age) VALUES ('Transaction Test 1', 'trans1@example.com', 45);
        INSERT INTO users (name, email, age) VALUES ('Transaction Test 2', 'trans2@example.com', 50);
        COMMIT;
      `, {});
      
      const result = await mariadbTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email LIKE 'trans%@example.com'",
        {}
      );
      expect(Number(result.rows[0].count)).toBe(2);
    });

    it('should handle MariaDB rollback correctly', async () => {
      // Get initial count
      const beforeResult = await mariadbTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email = 'rollback@example.com'",
        {}
      );
      const beforeCount = Number(beforeResult.rows[0].count);
      
      // Test rollback
      await mariadbTest.connector.executeSQL(`
        START TRANSACTION;
        INSERT INTO users (name, email, age) VALUES ('Rollback Test', 'rollback@example.com', 55);
        ROLLBACK;
      `, {});
      
      const afterResult = await mariadbTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email = 'rollback@example.com'",
        {}
      );
      const afterCount = Number(afterResult.rows[0].count);
      
      expect(afterCount).toBe(beforeCount);
    });

    it('should handle MariaDB-specific storage engines', async () => {
      await mariadbTest.connector.executeSQL(`
        CREATE TABLE IF NOT EXISTS engine_test (
          id INT AUTO_INCREMENT PRIMARY KEY,
          data VARCHAR(100)
        ) ENGINE=InnoDB
      `, {});

      await mariadbTest.connector.executeSQL(`
        INSERT INTO engine_test (data) VALUES ('InnoDB test data')
      `, {});

      const result = await mariadbTest.connector.executeSQL(`
        SELECT 
          TABLE_NAME,
          ENGINE
        FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'engine_test'
      `, {});
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].ENGINE).toBe('InnoDB');
    });

    it('should handle MariaDB virtual and computed columns', async () => {
      await mariadbTest.connector.executeSQL(`
        CREATE TABLE IF NOT EXISTS computed_test (
          id INT AUTO_INCREMENT PRIMARY KEY,
          first_name VARCHAR(50),
          last_name VARCHAR(50),
          full_name VARCHAR(101) AS (CONCAT(first_name, ' ', last_name)) VIRTUAL
        )
      `, {});

      await mariadbTest.connector.executeSQL(`
        INSERT INTO computed_test (first_name, last_name) 
        VALUES ('John', 'Doe'), ('Jane', 'Smith')
      `, {});

      const result = await mariadbTest.connector.executeSQL(`
        SELECT first_name, last_name, full_name 
        FROM computed_test 
        ORDER BY id
      `, {});
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].full_name).toBe('John Doe');
      expect(result.rows[1].full_name).toBe('Jane Smith');
    });

    it('should handle MariaDB sequence functionality', async () => {
      // MariaDB supports sequences similar to PostgreSQL
      await mariadbTest.connector.executeSQL(`
        CREATE SEQUENCE IF NOT EXISTS test_seq 
        START WITH 100 
        INCREMENT BY 5 
        MAXVALUE 1000
      `, {});

      const result = await mariadbTest.connector.executeSQL(`
        SELECT 
          NEXT VALUE FOR test_seq as next_val1,
          NEXT VALUE FOR test_seq as next_val2
      `, {});
      
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0].next_val1)).toBe(100);
      expect(Number(result.rows[0].next_val2)).toBe(105);
    });

    it('should respect maxRows limit for SELECT queries', async () => {
      // Test basic SELECT with maxRows limit
      const result = await mariadbTest.connector.executeSQL(
        'SELECT * FROM users ORDER BY id',
        { maxRows: 2 }
      );
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toHaveProperty('name');
      expect(result.rows[1]).toHaveProperty('name');
    });

    it('should respect existing LIMIT clause when lower than maxRows', async () => {
      // Test when existing LIMIT is lower than maxRows
      const result = await mariadbTest.connector.executeSQL(
        'SELECT * FROM users ORDER BY id LIMIT 1',
        { maxRows: 3 }
      );
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty('name');
    });

    it('should use maxRows when existing LIMIT is higher', async () => {
      // Test when existing LIMIT is higher than maxRows
      const result = await mariadbTest.connector.executeSQL(
        'SELECT * FROM users ORDER BY id LIMIT 10',
        { maxRows: 2 }
      );
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toHaveProperty('name');
      expect(result.rows[1]).toHaveProperty('name');
    });

    it('should not affect non-SELECT queries', async () => {
      // Test that maxRows doesn't affect INSERT/UPDATE/DELETE
      const insertResult = await mariadbTest.connector.executeSQL(
        "INSERT INTO users (name, email, age) VALUES ('MaxRows Test', 'maxrows@mariadb.com', 25)",
        { maxRows: 1 }
      );
      
      expect(insertResult.rows).toHaveLength(0); // INSERTs don't return rows by default
      
      // Verify the insert worked
      const selectResult = await mariadbTest.connector.executeSQL(
        "SELECT * FROM users WHERE email = 'maxrows@mariadb.com'",
        {}
      );
      expect(selectResult.rows).toHaveLength(1);
      expect(selectResult.rows[0].name).toBe('MaxRows Test');
    });

    it('should handle maxRows with complex queries', async () => {
      // Test maxRows with JOIN queries
      const result = await mariadbTest.connector.executeSQL(`
        SELECT u.name, o.total 
        FROM users u 
        JOIN orders o ON u.id = o.user_id 
        ORDER BY o.total DESC
      `, { maxRows: 2 });
      
      expect(result.rows.length).toBeLessThanOrEqual(2);
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]).toHaveProperty('name');
      expect(result.rows[0]).toHaveProperty('total');
    });

    it('should handle maxRows with multiple SELECT statements', async () => {
      // Test maxRows with multiple SELECT statements only  
      const result = await mariadbTest.connector.executeSQL(`
        SELECT name FROM users WHERE age > 20 ORDER BY name LIMIT 10;
        SELECT name FROM users WHERE age > 25 ORDER BY name LIMIT 10;
      `, { maxRows: 1 });
      
      // Should return only 1 row from each SELECT statement (due to maxRows limit)
      // MariaDB multi-statement may return more complex results, so we check that maxRows was applied
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows.length).toBeLessThanOrEqual(2); // At most 1 from each SELECT
      if (result.rows.length > 0) {
        expect(result.rows[0]).toHaveProperty('name');
      }
    });

    it('should ignore maxRows when not specified', async () => {
      // Test without maxRows - should return all rows
      const result = await mariadbTest.connector.executeSQL(
        'SELECT * FROM users ORDER BY id',
        {}
      );
      
      // Should return all users (at least the original 3 plus any added in previous tests)
      expect(result.rows.length).toBeGreaterThanOrEqual(3);
    });
  });
});