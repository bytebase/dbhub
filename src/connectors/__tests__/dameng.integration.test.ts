import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DaMengConnector } from '../damengdb/index.js';
import { IntegrationTestBase, type TestContainer, type DatabaseTestConfig } from './shared/integration-test-base.js';
import type { Connector } from '../interface.js';

class DaMengTestContainer implements TestContainer {
  constructor(private port: number = 5236) {}
  
  getConnectionUri(): string {
    // Return the connection string of the Dameng database
    return `dm://SYSDBA:SYSDBA@localhost:${this.port}?autoCommit=false`;
  }
  
  async stop(): Promise<void> {
    // Currently, Dameng does not have official support for testcontainers
    // Here, it is assumed that a locally installed instance of Dameng will be used for testing
    console.log('Stopping DaMeng test instance...');
  }
}

class DaMengIntegrationTest extends IntegrationTestBase<DaMengTestContainer> {
  constructor() {
    const config: DatabaseTestConfig = {
      expectedSchemas: ['SYSDBA'],
      expectedTables: ['USERS', 'ORDERS', 'PRODUCTS'],
      supportsStoredProcedures: true,
      expectedStoredProcedures: ['GET_USER_COUNT']
    };
    super(config);
  }

  async createContainer(): Promise<DaMengTestContainer> {
    return new DaMengTestContainer();
  }

  createConnector(): Connector {
    return new DaMengConnector();
  }

  async setupTestData(connector: Connector): Promise<void> {
    await connector.executeSQL(`
      CREATE TABLE USERS (
        ID NUMBER(10) PRIMARY KEY,
        NAME VARCHAR2(100) NOT NULL,
        EMAIL VARCHAR2(100) UNIQUE NOT NULL,
        AGE NUMBER(3)
      )
    `);

    await connector.executeSQL(`
      CREATE TABLE ORDERS (
        ID NUMBER(10) PRIMARY KEY,
        USER_ID NUMBER(10),
        TOTAL NUMBER(10,2),
        CREATED_AT TIMESTAMP DEFAULT SYSDATE,
        FOREIGN KEY (USER_ID) REFERENCES USERS(ID)
      )
    `);

    await connector.executeSQL(`
      CREATE TABLE PRODUCTS (
        ID NUMBER(10) PRIMARY KEY,
        NAME VARCHAR2(100) NOT NULL,
        PRICE NUMBER(10,2)
      )
    `);

    await connector.executeSQL(`
      INSERT INTO USERS (ID, NAME, EMAIL, AGE) VALUES 
      (1, 'John Doe', 'john@example.com', 30);
      INSERT INTO USERS (ID, NAME, EMAIL, AGE) VALUES 
      (2, 'Jane Smith', 'jane@example.com', 25);
      INSERT INTO USERS (ID, NAME, EMAIL, AGE) VALUES 
      (3, 'Bob Johnson', 'bob@example.com', 35)
    `);

    await connector.executeSQL(`
      INSERT INTO ORDERS (ID, USER_ID, TOTAL) VALUES 
      (1, 1, 99.99);
      INSERT INTO ORDERS (ID, USER_ID, TOTAL) VALUES 
      (2, 1, 149.50);
      INSERT INTO ORDERS (ID, USER_ID, TOTAL) VALUES 
      (3, 2, 75.25)
    `);

    await connector.executeSQL(`
      INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES 
      (1, 'Widget A', 19.99);
      INSERT INTO PRODUCTS (ID, NAME, PRICE) VALUES 
      (2, 'Widget B', 29.99)
    `);

    await connector.executeSQL(`
      CREATE OR REPLACE PROCEDURE GET_USER_COUNT(
        OUT total NUMBER
      ) AS
      BEGIN
        SELECT COUNT(*) INTO total FROM USERS;
      END;
    `);
  }
}

// Create a test suite
const damengTest = new DaMengIntegrationTest();

describe('DaMeng Connector Integration Tests', () => {
  beforeAll(async () => {
    await damengTest.setup();
  }, 120000);

  afterAll(async () => {
    await damengTest.cleanup();
  });

  // It includes all general tests
  damengTest.createConnectionTests();
  damengTest.createSchemaTests();
  damengTest.createTableTests();
  damengTest.createSQLExecutionTests();
  if (damengTest.config.supportsStoredProcedures) {
    damengTest.createStoredProcedureTests();
  }
  damengTest.createErrorHandlingTests();

  describe('DaMeng-specific Features', () => {
    it('should handle DaMeng sequences', async () => {
      await damengTest.connector.executeSQL(`
        CREATE SEQUENCE user_seq 
        START WITH 1
        INCREMENT BY 1
        NOCACHE
      `);

      await damengTest.connector.executeSQL(`
        INSERT INTO USERS (ID, NAME, EMAIL, AGE) 
        VALUES (user_seq.NEXTVAL, 'Sequence Test', 'seq@example.com', 40)
      `);
      
      const result = await damengTest.connector.executeSQL(
        "SELECT * FROM USERS WHERE EMAIL = 'seq@example.com'"
      );
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].ID).toBeGreaterThan(0);
    });

    it('should handle DaMeng-specific data types', async () => {
      await damengTest.connector.executeSQL(`
        CREATE TABLE dameng_types_test (
          id NUMBER(10) PRIMARY KEY,
          clob_data CLOB,
          blob_data BLOB,
          timestamp_val TIMESTAMP DEFAULT SYSDATE
        )
      `);

      await damengTest.connector.executeSQL(`
        INSERT INTO dameng_types_test (id, clob_data) 
        VALUES (1, 'Large text content')
      `);

      const result = await damengTest.connector.executeSQL(
        'SELECT * FROM dameng_types_test WHERE id = 1'
      );
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].CLOB_DATA).toBe('Large text content');
    });

    it('should execute PL/SQL blocks', async () => {
      const result = await damengTest.connector.executeSQL(`
        DECLARE
          v_count NUMBER;
        BEGIN
          SELECT COUNT(*) INTO v_count FROM USERS;
          :result := v_count;
        END;
      `);
      
      expect(result).toBeDefined();
    });

    it('should handle DaMeng system functions', async () => {
      const result = await damengTest.connector.executeSQL(`
        SELECT 
          USER as current_user,
          SYSDATE as current_date,
          SYSTIMESTAMP as current_timestamp
        FROM DUAL
      `);
      
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].CURRENT_USER).toBeDefined();
      expect(result.rows[0].CURRENT_DATE).toBeDefined();
      expect(result.rows[0].CURRENT_TIMESTAMP).toBeDefined();
    });

    it('should handle DaMeng transactions correctly', async () => {
      await damengTest.connector.executeSQL('SET AUTOCOMMIT OFF');
      
      await damengTest.connector.executeSQL(`
        BEGIN
          INSERT INTO USERS (ID, NAME, EMAIL, AGE) 
          VALUES (100, 'Transaction Test 1', 'trans1@example.com', 45);
          
          INSERT INTO USERS (ID, NAME, EMAIL, AGE) 
          VALUES (101, 'Transaction Test 2', 'trans2@example.com', 50);
          
          COMMIT;
        END;
      `);
      
      const result = await damengTest.connector.executeSQL(
        "SELECT COUNT(*) as count FROM USERS WHERE EMAIL LIKE 'trans%@example.com'"
      );
      expect(Number(result.rows[0].COUNT)).toBe(2);
    });
  });
});