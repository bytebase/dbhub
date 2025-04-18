import mysql from 'mysql2/promise';
import {
  Connector,
  ConnectorRegistry,
  DSNParser,
  QueryResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
} from '../interface.js';
import { allowedKeywords } from '../../utils/allowed-keywords.js';

/**
 * MySQL DSN Parser
 * Handles DSN strings like: mysql://user:password@localhost:3306/dbname
 */
class MySQLDSNParser implements DSNParser {
  async parse(dsn: string): Promise<mysql.ConnectionOptions> {
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      throw new Error(`Invalid MySQL DSN: ${dsn}`);
    }

    try {
      const url = new URL(dsn);

      const config: mysql.ConnectionOptions = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 3306,
        database: url.pathname.substring(1), // Remove leading '/'
        user: url.username,
        password: url.password ? decodeURIComponent(url.password) : '',
      };

      // Handle query parameters
      url.searchParams.forEach((value, key) => {
        if (key === 'ssl') {
          config.ssl = value === 'true' ? {} : undefined;
        }
        // Add other parameters as needed
      });

      return config;
    } catch (error) {
      throw new Error(`Failed to parse MySQL DSN: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getSampleDSN(): string {
    return 'mysql://root:password@localhost:3306/mysql';
  }

  isValidDSN(dsn: string): boolean {
    try {
      const url = new URL(dsn);
      return url.protocol === 'mysql:';
    } catch (error) {
      return false;
    }
  }
}

/**
 * MySQL Connector Implementation
 */
export class MySQLConnector implements Connector {
  id = 'mysql';
  name = 'MySQL';
  dsnParser = new MySQLDSNParser();

  private pool: mysql.Pool | null = null;

  async connect(dsn: string): Promise<void> {
    try {
      const config = await this.dsnParser.parse(dsn);
      this.pool = mysql.createPool(config);

      // Test the connection
      const [rows] = await this.pool.query('SELECT 1');
      console.error('Successfully connected to MySQL database');
    } catch (err) {
      console.error('Failed to connect to MySQL database:', err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async getSchemas(): Promise<string[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    try {
      // In MySQL, schemas are equivalent to databases
      const [rows] = (await this.pool.query(`
        SELECT SCHEMA_NAME 
        FROM INFORMATION_SCHEMA.SCHEMATA
        ORDER BY SCHEMA_NAME
      `)) as [any[], any];

      return rows.map((row) => row.SCHEMA_NAME);
    } catch (error) {
      console.error('Error getting schemas:', error);
      throw error;
    }
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    try {
      // In MySQL, if no schema is provided, use the current active database (DATABASE())
      // MySQL uses the terms 'database' and 'schema' interchangeably
      // The DATABASE() function returns the current database context
      const schemaClause = schema ? 'WHERE TABLE_SCHEMA = ?' : 'WHERE TABLE_SCHEMA = DATABASE()';

      const queryParams = schema ? [schema] : [];

      // Get all tables from the specified schema or current database
      const [rows] = (await this.pool.query(
        `
        SELECT TABLE_NAME 
        FROM INFORMATION_SCHEMA.TABLES 
        ${schemaClause}
        ORDER BY TABLE_NAME
      `,
        queryParams
      )) as [any[], any];

      return rows.map((row) => row.TABLE_NAME);
    } catch (error) {
      console.error('Error getting tables:', error);
      throw error;
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    try {
      // In MySQL, if no schema is provided, use the current active database
      // DATABASE() function returns the name of the current database
      const schemaClause = schema ? 'WHERE TABLE_SCHEMA = ?' : 'WHERE TABLE_SCHEMA = DATABASE()';

      const queryParams = schema ? [schema, tableName] : [tableName];

      const [rows] = (await this.pool.query(
        `
        SELECT COUNT(*) AS COUNT
        FROM INFORMATION_SCHEMA.TABLES 
        ${schemaClause} 
        AND TABLE_NAME = ?
      `,
        queryParams
      )) as [any[], any];

      return rows[0].COUNT > 0;
    } catch (error) {
      console.error('Error checking if table exists:', error);
      throw error;
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    try {
      // In MySQL, if no schema is provided, use the current active database
      const schemaClause = schema ? 'TABLE_SCHEMA = ?' : 'TABLE_SCHEMA = DATABASE()';

      const queryParams = schema ? [schema, tableName] : [tableName];

      // Get information about indexes
      const [indexRows] = (await this.pool.query(
        `
        SELECT 
          INDEX_NAME,
          COLUMN_NAME,
          NON_UNIQUE,
          SEQ_IN_INDEX
        FROM 
          INFORMATION_SCHEMA.STATISTICS 
        WHERE 
          ${schemaClause}
          AND TABLE_NAME = ? 
        ORDER BY 
          INDEX_NAME, 
          SEQ_IN_INDEX
      `,
        queryParams
      )) as [any[], any];

      // Process the results to group columns by index
      const indexMap = new Map<
        string,
        {
          columns: string[];
          is_unique: boolean;
          is_primary: boolean;
        }
      >();

      for (const row of indexRows) {
        const indexName = row.INDEX_NAME;
        const columnName = row.COLUMN_NAME;
        const isUnique = row.NON_UNIQUE === 0; // In MySQL, NON_UNIQUE=0 means the index is unique
        const isPrimary = indexName === 'PRIMARY';

        if (!indexMap.has(indexName)) {
          indexMap.set(indexName, {
            columns: [],
            is_unique: isUnique,
            is_primary: isPrimary,
          });
        }

        const indexInfo = indexMap.get(indexName)!;
        indexInfo.columns.push(columnName);
      }

      // Convert the map to the expected TableIndex format
      const results: TableIndex[] = [];
      indexMap.forEach((indexInfo, indexName) => {
        results.push({
          index_name: indexName,
          column_names: indexInfo.columns,
          is_unique: indexInfo.is_unique,
          is_primary: indexInfo.is_primary,
        });
      });

      return results;
    } catch (error) {
      console.error('Error getting table indexes:', error);
      throw error;
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    try {
      // In MySQL, schema is synonymous with database
      // If no schema is provided, use the current database context via DATABASE() function
      // This means tables will be retrieved from whatever database the connection is currently using
      const schemaClause = schema ? 'WHERE TABLE_SCHEMA = ?' : 'WHERE TABLE_SCHEMA = DATABASE()';

      const queryParams = schema ? [schema, tableName] : [tableName];

      // Get table columns
      const [rows] = (await this.pool.query(
        `
        SELECT 
          COLUMN_NAME as column_name, 
          DATA_TYPE as data_type, 
          IS_NULLABLE as is_nullable,
          COLUMN_DEFAULT as column_default
        FROM INFORMATION_SCHEMA.COLUMNS
        ${schemaClause}
        AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `,
        queryParams
      )) as [any[], any];

      return rows;
    } catch (error) {
      console.error('Error getting table schema:', error);
      throw error;
    }
  }

  async getStoredProcedures(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    try {
      // In MySQL, if no schema is provided, use the current database context
      const schemaClause = schema ? 'WHERE ROUTINE_SCHEMA = ?' : 'WHERE ROUTINE_SCHEMA = DATABASE()';

      const queryParams = schema ? [schema] : [];

      // Get all stored procedures and functions
      const [rows] = (await this.pool.query(
        `
        SELECT ROUTINE_NAME
        FROM INFORMATION_SCHEMA.ROUTINES
        ${schemaClause}
        ORDER BY ROUTINE_NAME
      `,
        queryParams
      )) as [any[], any];

      return rows.map((row) => row.ROUTINE_NAME);
    } catch (error) {
      console.error('Error getting stored procedures:', error);
      throw error;
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    try {
      // In MySQL, if no schema is provided, use the current database context
      const schemaClause = schema ? 'WHERE r.ROUTINE_SCHEMA = ?' : 'WHERE r.ROUTINE_SCHEMA = DATABASE()';

      const queryParams = schema ? [schema, procedureName] : [procedureName];

      // Get details of the stored procedure
      const [rows] = (await this.pool.query(
        `
        SELECT 
          r.ROUTINE_NAME AS procedure_name,
          CASE 
            WHEN r.ROUTINE_TYPE = 'PROCEDURE' THEN 'procedure'
            ELSE 'function'
          END AS procedure_type,
          LOWER(r.ROUTINE_TYPE) AS routine_type,
          r.ROUTINE_DEFINITION,
          r.DTD_IDENTIFIER AS return_type,
          (
            SELECT GROUP_CONCAT(
              CONCAT(p.PARAMETER_NAME, ' ', p.PARAMETER_MODE, ' ', p.DATA_TYPE)
              ORDER BY p.ORDINAL_POSITION
              SEPARATOR ', '
            )
            FROM INFORMATION_SCHEMA.PARAMETERS p
            WHERE p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA
            AND p.SPECIFIC_NAME = r.ROUTINE_NAME
            AND p.PARAMETER_NAME IS NOT NULL
          ) AS parameter_list
        FROM INFORMATION_SCHEMA.ROUTINES r
        ${schemaClause}
        AND r.ROUTINE_NAME = ?
      `,
        queryParams
      )) as [any[], any];

      if (rows.length === 0) {
        const schemaName = schema || 'current schema';
        throw new Error(`Stored procedure '${procedureName}' not found in ${schemaName}`);
      }

      const procedure = rows[0];

      // If ROUTINE_DEFINITION is NULL, try to get the procedure body from mysql.proc
      let definition = procedure.ROUTINE_DEFINITION;

      try {
        const schemaValue = schema || (await this.getCurrentSchema());

        // For full definition - different approaches based on type
        if (procedure.procedure_type === 'procedure') {
          // Try to get the definition from SHOW CREATE PROCEDURE
          try {
            const [defRows] = (await this.pool.query(`
              SHOW CREATE PROCEDURE ${schemaValue}.${procedureName}
            `)) as [any[], any];

            if (defRows && defRows.length > 0) {
              definition = defRows[0]['Create Procedure'];
            }
          } catch (err) {
            console.error(`Error getting procedure definition with SHOW CREATE: ${err}`);
          }
        } else {
          // Try to get the definition for functions
          try {
            const [defRows] = (await this.pool.query(`
              SHOW CREATE FUNCTION ${schemaValue}.${procedureName}
            `)) as [any[], any];

            if (defRows && defRows.length > 0) {
              definition = defRows[0]['Create Function'];
            }
          } catch (innerErr) {
            console.error(`Error getting function definition with SHOW CREATE: ${innerErr}`);
          }
        }

        // Last attempt - try to get from information_schema.routines if not found yet
        if (!definition) {
          const [bodyRows] = (await this.pool.query(
            `
            SELECT ROUTINE_DEFINITION, ROUTINE_BODY 
            FROM INFORMATION_SCHEMA.ROUTINES
            WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?
          `,
            [schemaValue, procedureName]
          )) as [any[], any];

          if (bodyRows && bodyRows.length > 0) {
            if (bodyRows[0].ROUTINE_DEFINITION) {
              definition = bodyRows[0].ROUTINE_DEFINITION;
            } else if (bodyRows[0].ROUTINE_BODY) {
              definition = bodyRows[0].ROUTINE_BODY;
            }
          }
        }
      } catch (error) {
        // Ignore errors when getting definition - it's optional
        console.error(`Error getting procedure/function details: ${error}`);
      }

      return {
        procedure_name: procedure.procedure_name,
        procedure_type: procedure.procedure_type,
        language: 'sql', // MySQL procedures are generally in SQL
        parameter_list: procedure.parameter_list || '',
        return_type: procedure.routine_type === 'function' ? procedure.return_type : undefined,
        definition: definition || undefined,
      };
    } catch (error) {
      console.error('Error getting stored procedure detail:', error);
      throw error;
    }
  }

  // Helper method to get current schema (database) name
  private async getCurrentSchema(): Promise<string> {
    const [rows] = (await this.pool!.query('SELECT DATABASE() AS DB')) as [any[], any];
    return rows[0].DB;
  }

  async executeQuery(query: string): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    const safetyCheck = this.validateQuery(query);
    if (!safetyCheck.isValid) {
      throw new Error(safetyCheck.message || 'Query validation failed');
    }

    try {
      const [rows, fields] = (await this.pool.query(query)) as [any[], any];
      return { rows, fields };
    } catch (error) {
      console.error('Error executing query:', error);
      throw error;
    }
  }

  validateQuery(query: string): { isValid: boolean; message?: string } {
    // Basic check to prevent non-SELECT queries
    const normalizedQuery = query.trim().toLowerCase();
    if (!allowedKeywords.some((keyword) => normalizedQuery.startsWith(keyword))) {
      return {
        isValid: false,
        message: 'Only SELECT queries are allowed for security reasons.',
      };
    }
    return { isValid: true };
  }
}

// Create and register the connector
const mysqlConnector = new MySQLConnector();
ConnectorRegistry.register(mysqlConnector);
