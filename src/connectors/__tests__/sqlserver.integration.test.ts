import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MSSQLServerContainer, StartedMSSQLServerContainer } from '@testcontainers/mssqlserver';
import { SQLServerConnector } from '../sqlserver/index.js';
import { IntegrationTestBase, type TestContainer, type DatabaseTestConfig } from './shared/integration-test-base.js';
import type { Connector } from '../interface.js';

class SQLServerTestContainer implements TestContainer {
  constructor(private container: StartedMSSQLServerContainer) {}
  
  getConnectionUri(): string {
    // Get the container's connection details
    const host = this.container.getHost();
    const port = this.container.getMappedPort(1433);
    
    // Convert to our expected DSN format: sqlserver://username:password@host:port/database
    // Use sslmode=disable for test containers to avoid certificate issues
    return `sqlserver://sa:Password123!@${host}:${port}/master?sslmode=disable`;
  }
  
  getHost(): string {
    return this.container.getHost();
  }
  
  getMappedPort(port: number): number {
    return this.container.getMappedPort(port);
  }
  
  async stop(): Promise<void> {
    await this.container.stop();
  }
}

class SQLServerIntegrationTest extends IntegrationTestBase<SQLServerTestContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      expectedSchemas: ['dbo', 'INFORMATION_SCHEMA'],
      expectedTables: ['users', 'orders', 'products'],
      supportsStoredProcedures: true,
      expectedStoredProcedures: ['GetUserCount', 'CalculateTotalAge']
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

// Create the test suite
const sqlServerTest = new SQLServerIntegrationTest();

// NOTE: SQL Server containers may take several minutes to start due to licensing requirements
// and initialization time. If tests time out, consider increasing timeout or running with
// more Docker resources allocated.
describe('SQL Server Connector Integration Tests', () => {
  beforeAll(async () => {
    await sqlServerTest.setup();
  }, 300000); // 5 minutes timeout for SQL Server container

  afterAll(async () => {
    await sqlServerTest.cleanup();
  });

  // Include all common tests
  sqlServerTest.createConnectionTests();
  sqlServerTest.createSchemaTests();
  sqlServerTest.createTableTests();
  sqlServerTest.createSQLExecutionTests();
  if (sqlServerTest.config.supportsStoredProcedures) {
    sqlServerTest.createStoredProcedureTests();
  }
  sqlServerTest.createErrorHandlingTests();

  describe('Named Instance Configuration', () => {
    it('should parse instanceName from query parameter', async () => {
      const parser = new SQLServerConnector().dsnParser;
      const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb?instanceName=ENV1');

      expect(config.options?.instanceName).toBe('ENV1');
      expect(config.server).toBe('localhost');
      expect(config.port).toBe(1433);
      expect(config.database).toBe('testdb');
    });

    it('should parse instanceName with other query parameters', async () => {
      const parser = new SQLServerConnector().dsnParser;
      const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb?instanceName=ENV2&sslmode=disable');

      expect(config.options?.instanceName).toBe('ENV2');
      expect(config.options?.encrypt).toBe(false);
    });

    it('should work without instanceName (backward compatibility)', async () => {
      const parser = new SQLServerConnector().dsnParser;
      const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb');

      expect(config.options?.instanceName).toBeUndefined();
      expect(config.server).toBe('localhost');
      expect(config.port).toBe(1433);
    });
  });

  describe('SQL Server SSL/TLS Configuration', () => {
    it('should parse sslmode=disable correctly', async () => {
      const parser = new SQLServerConnector().dsnParser;
      const config = await parser.parse('sqlserver://user:pass@localhost:1433/db?sslmode=disable');

      expect(config.options?.encrypt).toBe(false);
      expect(config.options?.trustServerCertificate).toBe(false);
    });

    it('should parse sslmode=require correctly', async () => {
      const parser = new SQLServerConnector().dsnParser;
      const config = await parser.parse('sqlserver://user:pass@localhost:1433/db?sslmode=require');
      
      expect(config.options?.encrypt).toBe(true);
      expect(config.options?.trustServerCertificate).toBe(true);
    });

    it('should default to unencrypted when no sslmode specified', async () => {
      const parser = new SQLServerConnector().dsnParser;
      const config = await parser.parse('sqlserver://user:pass@localhost:1433/db');
      
      expect(config.options?.encrypt).toBe(false);
      expect(config.options?.trustServerCertificate).toBe(false);
    });

    it('should connect successfully with sslmode=disable (unencrypted)', async () => {
      const connector = new SQLServerConnector();
      const host = (sqlServerTest as any).container.getHost();
      const port = (sqlServerTest as any).container.getMappedPort(1433);
      const dsn = `sqlserver://sa:Password123!@${host}:${port}/master?sslmode=disable`;
      
      await connector.connect(dsn);
      
      // Verify this is an unencrypted connection by checking connection properties
      const encryptionResult = await connector.executeSQL(`
        SELECT 
          CAST(CONNECTIONPROPERTY('protocol_type') AS NVARCHAR(100)) as protocol_type,
          CASE 
            WHEN CAST(CONNECTIONPROPERTY('protocol_type') AS NVARCHAR(100)) LIKE '%TLS%' 
              OR CAST(CONNECTIONPROPERTY('protocol_type') AS NVARCHAR(100)) LIKE '%SSL%' 
            THEN 'Encrypted' 
            ELSE 'Unencrypted' 
          END as encryption_status
      `, {});
      
      expect(encryptionResult.rows[0].encryption_status).toBe('Unencrypted');
      expect(encryptionResult.rows[0].protocol_type).not.toMatch(/TLS|SSL/i);
      
      await connector.disconnect();
    });
  });

  describe('SQL Server-specific Features', () => {
    it('should handle SQL Server IDENTITY columns', async () => {
      await sqlServerTest.connector.executeSQL(`
        CREATE TABLE identity_test (
          id INT IDENTITY(1,1) PRIMARY KEY,
          name NVARCHAR(50)
        )
      `, {});

      await sqlServerTest.connector.executeSQL(`
        INSERT INTO identity_test (name) VALUES ('Test 1'), ('Test 2')
      `, {});

      const result = await sqlServerTest.connector.executeSQL(
        'SELECT * FROM identity_test ORDER BY id',
        {}
      );
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].id).toBe(1);
      expect(result.rows[1].id).toBe(2);
      expect(result.rows[0].name).toBe('Test 1');
    });

    it('should handle SQL Server-specific data types', async () => {
      await sqlServerTest.connector.executeSQL(`
        CREATE TABLE sqlserver_types_test (
          id INT IDENTITY(1,1) PRIMARY KEY,
          unicode_text NVARCHAR(MAX),
          datetime_val DATETIME2,
          unique_id UNIQUEIDENTIFIER DEFAULT NEWID(),
          xml_data XML,
          binary_data VARBINARY(100)
        )
      `, {});

      await sqlServerTest.connector.executeSQL(`
        INSERT INTO sqlserver_types_test (unicode_text, datetime_val, xml_data, binary_data) 
        VALUES (N'Unicode Text 测试', GETDATE(), '<root><item>test</item></root>', 0x48656C6C6F)
      `, {});

      const result = await sqlServerTest.connector.executeSQL(
        'SELECT * FROM sqlserver_types_test',
        {}
      );
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].unicode_text).toBe('Unicode Text 测试');
      expect(result.rows[0].unique_id).toBeDefined();
      expect(result.rows[0].xml_data).toBeDefined();
    });

    it('should work with SQL Server-specific functions', async () => {
      const result = await sqlServerTest.connector.executeSQL(`
        SELECT 
          @@VERSION as sql_version,
          DB_NAME() as current_db,
          SUSER_NAME() as current_user_name,
          GETDATE() as current_datetime,
          NEWID() as new_guid
      `, {});
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].sql_version).toContain('Microsoft SQL Server');
      expect(result.rows[0].current_db).toBeDefined();
      expect(result.rows[0].current_user_name).toBeDefined();
      expect(result.rows[0].current_datetime).toBeDefined();
      expect(result.rows[0].new_guid).toBeDefined();
    });

    it('should handle SQL Server transactions correctly', async () => {
      // Test explicit transaction
      await sqlServerTest.connector.executeSQL(`
        BEGIN TRANSACTION;
        INSERT INTO users (name, email, age) VALUES ('Transaction Test 1', 'trans1@example.com', 45);
        INSERT INTO users (name, email, age) VALUES ('Transaction Test 2', 'trans2@example.com', 50);
        COMMIT TRANSACTION;
      `, {});
      
      const result = await sqlServerTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email LIKE 'trans%@example.com'",
        {}
      );
      expect(Number(result.rows[0].count)).toBe(2);
    });

    it('should handle SQL Server rollback correctly', async () => {
      // Get initial count
      const beforeResult = await sqlServerTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email = 'rollback@example.com'",
        {}
      );
      const beforeCount = Number(beforeResult.rows[0].count);
      
      // Test rollback
      await sqlServerTest.connector.executeSQL(`
        BEGIN TRANSACTION;
        INSERT INTO users (name, email, age) VALUES ('Rollback Test', 'rollback@example.com', 55);
        ROLLBACK TRANSACTION;
      `, {});
      
      const afterResult = await sqlServerTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM users WHERE email = 'rollback@example.com'",
        {}
      );
      const afterCount = Number(afterResult.rows[0].count);
      
      expect(afterCount).toBe(beforeCount);
    });

    it('should handle SQL Server OUTPUT clause', async () => {
      const result = await sqlServerTest.connector.executeSQL(`
        INSERT INTO users (name, email, age) 
        OUTPUT INSERTED.id, INSERTED.name
        VALUES ('Output Test', 'output@example.com', 40)
      `, {});
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBeDefined();
      expect(result.rows[0].name).toBe('Output Test');
    });

    it('should handle SQL Server window functions', async () => {
      const result = await sqlServerTest.connector.executeSQL(`
        SELECT 
          name,
          age,
          ROW_NUMBER() OVER (ORDER BY age DESC) as age_rank,
          AVG(CAST(age AS FLOAT)) OVER () as avg_age
        FROM users
        WHERE age IS NOT NULL
        ORDER BY age DESC
      `, {});
      
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]).toHaveProperty('age_rank');
      expect(result.rows[0]).toHaveProperty('avg_age');
    });

    it('should handle SQL Server CTEs (Common Table Expressions)', async () => {
      const result = await sqlServerTest.connector.executeSQL(`
        WITH UserOrderSummary AS (
          SELECT 
            u.name,
            COUNT(o.id) as order_count,
            SUM(o.total) as total_spent
          FROM users u
          LEFT JOIN orders o ON u.id = o.user_id
          GROUP BY u.id, u.name
        )
        SELECT * FROM UserOrderSummary 
        WHERE order_count > 0
        ORDER BY total_spent DESC
      `, {});
      
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]).toHaveProperty('name');
      expect(result.rows[0]).toHaveProperty('order_count');
      expect(result.rows[0]).toHaveProperty('total_spent');
    });

    it('should handle SQL Server JSON functions (SQL Server 2016+)', async () => {
      await sqlServerTest.connector.executeSQL(`
        CREATE TABLE json_test (
          id INT IDENTITY(1,1) PRIMARY KEY,
          data NVARCHAR(MAX)
        )
      `, {});

      await sqlServerTest.connector.executeSQL(`
        INSERT INTO json_test (data) VALUES 
        (N'{"name": "John", "tags": ["admin", "user"], "settings": {"theme": "dark"}}'),
        (N'{"name": "Jane", "tags": ["user"], "settings": {"theme": "light"}}')
      `, {});

      const result = await sqlServerTest.connector.executeSQL(`
        SELECT 
          JSON_VALUE(data, '$.name') as name,
          JSON_VALUE(data, '$.settings.theme') as theme,
          JSON_QUERY(data, '$.tags') as tags
        FROM json_test
        WHERE JSON_VALUE(data, '$.name') = 'John'
      `, {});
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('John');
      expect(result.rows[0].theme).toBe('dark');
      expect(result.rows[0].tags).toBeDefined();
    });

    it('should handle SQL Server MERGE statement', async () => {
      // Create a staging table
      await sqlServerTest.connector.executeSQL(`
        CREATE TABLE users_staging (
          id INT,
          name NVARCHAR(100),
          email NVARCHAR(100),
          age INT
        )
      `, {});

      await sqlServerTest.connector.executeSQL(`
        INSERT INTO users_staging (id, name, email, age) VALUES 
        (1, 'John Doe Updated', 'john@example.com', 31),
        (999, 'New User', 'new@example.com', 25)
      `, {});

      const result = await sqlServerTest.connector.executeSQL(`
        MERGE users AS target
        USING users_staging AS source
        ON target.id = source.id
        WHEN MATCHED THEN
          UPDATE SET name = source.name, age = source.age
        WHEN NOT MATCHED THEN
          INSERT (name, email, age) VALUES (source.name, source.email, source.age)
        OUTPUT $action, INSERTED.name;
      `, {});
      
      expect(result.rows.length).toBeGreaterThan(0);
      // Should have both UPDATE and INSERT actions
      const actions = result.rows.map(row => row.$action);
      expect(actions).toContain('UPDATE');
      expect(actions).toContain('INSERT');
    });

    it('should respect maxRows limit for SELECT queries', async () => {
      // Test basic SELECT with maxRows limit
      const result = await sqlServerTest.connector.executeSQL(
        'SELECT * FROM users ORDER BY id',
        { maxRows: 2 }
      );
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toHaveProperty('name');
      expect(result.rows[1]).toHaveProperty('name');
    });

    it('should respect existing TOP clause when lower than maxRows', async () => {
      // Test when existing TOP is lower than maxRows
      const result = await sqlServerTest.connector.executeSQL(
        'SELECT TOP 1 * FROM users ORDER BY id',
        { maxRows: 3 }
      );
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty('name');
    });

    it('should use maxRows when existing TOP is higher', async () => {
      // Test when existing TOP is higher than maxRows
      const result = await sqlServerTest.connector.executeSQL(
        'SELECT TOP 10 * FROM users ORDER BY id',
        { maxRows: 2 }
      );
      
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toHaveProperty('name');
      expect(result.rows[1]).toHaveProperty('name');
    });

    it('should not affect non-SELECT queries', async () => {
      // Test that maxRows doesn't affect INSERT/UPDATE/DELETE
      const insertResult = await sqlServerTest.connector.executeSQL(
        "INSERT INTO users (name, email, age) VALUES ('MaxRows Test', 'maxrows@sqlserver.com', 25)",
        { maxRows: 1 }
      );
      
      expect(insertResult.rows).toHaveLength(0); // INSERTs without OUTPUT don't return rows by default
      
      // Verify the insert worked
      const selectResult = await sqlServerTest.connector.executeSQL(
        "SELECT * FROM users WHERE email = 'maxrows@sqlserver.com'",
        {}
      );
      expect(selectResult.rows).toHaveLength(1);
      expect(selectResult.rows[0].name).toBe('MaxRows Test');
    });

    it('should handle maxRows with complex queries', async () => {
      // Test maxRows with JOIN queries
      const result = await sqlServerTest.connector.executeSQL(`
        SELECT u.name, o.total 
        FROM users u 
        INNER JOIN orders o ON u.id = o.user_id 
        ORDER BY o.total DESC
      `, { maxRows: 2 });
      
      expect(result.rows.length).toBeLessThanOrEqual(2);
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]).toHaveProperty('name');
      expect(result.rows[0]).toHaveProperty('total');
    });

    it('should handle maxRows with window functions', async () => {
      // Test maxRows with window function queries
      const result = await sqlServerTest.connector.executeSQL(`
        SELECT 
          name,
          age,
          ROW_NUMBER() OVER (ORDER BY age DESC) as age_rank
        FROM users
        WHERE age IS NOT NULL
        ORDER BY age DESC
      `, { maxRows: 2 });
      
      expect(result.rows.length).toBeLessThanOrEqual(2);
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0]).toHaveProperty('name');
      expect(result.rows[0]).toHaveProperty('age_rank');
    });

    it('should ignore maxRows when not specified', async () => {
      // Test without maxRows - should return all rows
      const result = await sqlServerTest.connector.executeSQL(
        'SELECT * FROM users ORDER BY id',
        {}
      );
      
      // Should return all users (at least the original 3 plus any added in previous tests)
      expect(result.rows.length).toBeGreaterThanOrEqual(3);
    });
  });
});