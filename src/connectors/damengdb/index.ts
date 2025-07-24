import db from 'dmdb';
import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";

/**
 * DaMeng DSN Parser 
 * Handles DSN strings like: dm://SYSDBA:SYSDBA@localhost:5236?autoCommit=false
 */
class DaMengDSNParser implements DSNParser {
  async parse(dsn: string): Promise<any> {
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid DaMeng DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      const url = new SafeURL(dsn);

      const config = {
        connectString: dsn,
        poolMax: 10,
        poolMin: 1
      };

      return config;
    } catch (error) {
      throw new Error(
        `Failed to parse DaMeng DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "dm://SYSDBA:SYSDBA@localhost:5236?autoCommit=false";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith('dm://');
    } catch (error) {
      return false;
    }
  }
}

/**
 * DaMeng Connector Implementation
 */
export class DaMengConnector implements Connector {
  id: ConnectorType = "dameng";
  name = "DaMeng";
  dsnParser = new DaMengDSNParser();

  private pool: db.Pool | null = null;
  private conn: db.Connection | null = null;

  async connect(dsn: string): Promise<void> {
    try {
      const config = await this.dsnParser.parse(dsn);
      this.pool = await db.createPool(config);
      this.conn = await this.pool.getConnection();

      // Test the connection
      await this.conn.execute("SELECT 1 FROM DUAL");
      console.error("Successfully connected to DaMeng database");
    } catch (err) {
      console.error("Failed to connect to DaMeng database:", err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.conn) {
        await this.conn.close();
        this.conn = null;
      }
      if (this.pool) {
        await this.pool.close();
        this.pool = null;
      }
    } catch (error) {
      console.error("Error disconnecting:", error);
      throw error;
    }
  }

  async getSchemas(): Promise<string[]> {
    if (!this.conn) {
      throw new Error("Not connected to database");
    }

    try {
      const result = await this.conn.execute(`
        SELECT DISTINCT OWNER AS SCHEMA_NAME 
        FROM ALL_OBJECTS 
        WHERE OWNER NOT IN ('SYS','SYSDBA')
        ORDER BY OWNER
      `);

      return ((result.rows ?? []) as any[]).map((row: any[]) => row[0]);
    } catch (error) {
      console.error("Error getting schemas:", error);
      throw error;
    }
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.conn) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaClause = schema ? `AND OWNER = '${schema}'` : '';
      const result = await this.conn.execute(`
        SELECT TABLE_NAME 
        FROM ALL_TABLES 
        WHERE 1=1 ${schemaClause}
        ORDER BY TABLE_NAME
      `);

      return ((result.rows ?? []) as any[]).map((row: any[]) => row[0]);
    } catch (error) {
      console.error("Error getting tables:", error);
      throw error;
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.conn) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaClause = schema ? `AND OWNER = '${schema}'` : '';
      const result = await this.conn.execute(`
        SELECT 
          COLUMN_NAME as column_name,
          DATA_TYPE as data_type,
          NULLABLE as is_nullable,
          DATA_DEFAULT as column_default
        FROM ALL_TAB_COLUMNS 
        WHERE TABLE_NAME = '${tableName}' ${schemaClause}
        ORDER BY COLUMN_ID
      `);

      return ((result.rows ?? []) as any[]).map((row: any[]) => ({
        column_name: row[0],
        data_type: row[1],
        is_nullable: row[2],
        column_default: row[3]
      }));
    } catch (error) {
      console.error("Error getting table schema:", error);
      throw error;
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.conn) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaClause = schema ? `AND OWNER = '${schema}'` : '';
      const result = await this.conn.execute(`
        SELECT COUNT(*) AS count 
        FROM ALL_TABLES 
        WHERE TABLE_NAME = '${tableName.toUpperCase()}' ${schemaClause}
      `);

      return (((result.rows ?? []) as any[])[0]?.[0] ?? 0) > 0;
    } catch (error) {
      console.error("Error checking if table exists:", error);
      throw error;
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.conn) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaClause = schema ? `AND i.OWNER = '${schema}'` : '';
      const result = await this.conn.execute(`
        SELECT 
          i.INDEX_NAME,
          i.UNIQUENESS,
          LISTAGG(c.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY c.COLUMN_POSITION) as COLUMN_NAMES,
          CASE WHEN i.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END as IS_PRIMARY
        FROM ALL_INDEXES i
        JOIN ALL_IND_COLUMNS c ON i.INDEX_NAME = c.INDEX_NAME AND i.OWNER = c.INDEX_OWNER
        WHERE i.TABLE_NAME = '${tableName.toUpperCase()}' ${schemaClause}
        GROUP BY i.INDEX_NAME, i.UNIQUENESS, i.CONSTRAINT_TYPE
        ORDER BY i.INDEX_NAME
      `);

      return ((result.rows ?? []) as any[]).map(row => ({
        index_name: row[0],
        is_unique: row[1] === 'UNIQUE',
        column_names: (row[2] as string).split(','),
        is_primary: row[3] === 1
      }));
    } catch (error) {
      console.error("Error getting table indexes:", error);
      throw error;
    }
  }

  async getStoredProcedures(schema?: string): Promise<string[]> {
    if (!this.conn) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaClause = schema ? `AND OWNER = '${schema}'` : '';
      const result = await this.conn.execute(`
        SELECT OBJECT_NAME 
        FROM ALL_OBJECTS 
        WHERE OBJECT_TYPE = 'PROCEDURE' ${schemaClause}
        ORDER BY OBJECT_NAME
      `);

      return ((result.rows ?? []) as any[]).map(row => row[0]);
    } catch (error) {
      console.error("Error getting stored procedures:", error);
      throw error;
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.conn) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaClause = schema ? `AND OWNER = '${schema}'` : '';
      const result = await this.conn.execute(`
        SELECT 
          NAME as procedure_name,
          TYPE as procedure_type,
          LISTAGG(TEXT, '') WITHIN GROUP (ORDER BY LINE) as definition
        FROM ALL_SOURCE 
        WHERE NAME = '${procedureName.toUpperCase()}' ${schemaClause}
        GROUP BY NAME, TYPE
      `);

      if (!result.rows?.length) {
        throw new Error(`Stored procedure '${procedureName}' not found`);
      }

      const row = result.rows[0] as any[];
      return {
        procedure_name: row[0],
        procedure_type: row[1].toLowerCase().includes('function') ? 'function' : 'procedure',
        language: 'PL/SQL',
        parameter_list: '', // 需要额外查询参数信息
        definition: row[2]
      };
    } catch (error) {
      console.error("Error getting stored procedure details:", error);
      throw error;
    }
  }

  async executeSQL(sql: string): Promise<SQLResult> {
    if (!this.conn) {
      throw new Error("Not connected to database");
    }

    try {
      const result = await this.conn.execute(sql);
      return { 
        rows: result.rows || []
      };
    } catch (error) {
      console.error("Error executing query:", error);
      throw error;
    }
  }
}

// Create and register the connector
const damengConnector = new DaMengConnector();
ConnectorRegistry.register(damengConnector);
