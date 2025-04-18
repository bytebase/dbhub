import sql from 'mssql';
import {
  Connector,
  ConnectorRegistry,
  DSNParser,
  QueryResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
} from '../interface.js';
import { DefaultAzureCredential } from '@azure/identity';
import { allowedKeywords } from '../../utils/allowed-keywords.js';

/**
 * SQL Server DSN parser
 * Expected format: mssql://username:password@host:port/database
 */
export class SQLServerDSNParser implements DSNParser {
  async parse(dsn: string): Promise<sql.config> {
    // Remove the protocol prefix
    if (!this.isValidDSN(dsn)) {
      throw new Error('Invalid SQL Server DSN format. Expected: sqlserver://username:password@host:port/database');
    }

    // Parse the DSN
    const url = new URL(dsn);
    const host = url.hostname;
    const port = url.port ? parseInt(url.port, 10) : 1433; // Default SQL Server port
    const database = url.pathname.substring(1); // Remove leading slash
    const user = url.username;
    const password = url.password ? decodeURIComponent(url.password) : '';

    // Parse additional options from query parameters
    const options: Record<string, any> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (key === 'encrypt') {
        options.encrypt = value;
      } else if (key === 'trustServerCertificate') {
        options.trustServerCertificate = value === 'true';
      } else if (key === 'connectTimeout') {
        options.connectTimeout = parseInt(value, 10);
      } else if (key === 'requestTimeout') {
        options.requestTimeout = parseInt(value, 10);
      } else if (key === 'authentication') {
        options.authentication = value;
      }
    }

    // Base configuration without authentication first
    const config: sql.config = {
      user,
      password,
      server: host,
      port,
      database,
      options: {
        encrypt: options.encrypt ?? true, // Default to encrypted connection
        trustServerCertificate: options.trustServerCertificate === true, // Need explicit conversion to boolean
        connectTimeout: options.connectTimeout ?? 15000,
        requestTimeout: options.requestTimeout ?? 15000,
      },
    };

    // Handle Azure Active Directory authentication with access token
    if (options.authentication === 'azure-active-directory-access-token') {
      try {
        // Create a credential instance
        const credential = new DefaultAzureCredential();

        // Get token for SQL Server resource
        const token = await credential.getToken('https://database.windows.net/');

        // Set the token in the config
        config.authentication = {
          type: 'azure-active-directory-access-token',
          options: {
            token: token.token,
          },
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to get Azure AD token: ${errorMessage}`);
      }
    }

    return config;
  }

  getSampleDSN(): string {
    return 'sqlserver://username:password@localhost:1433/database?encrypt=true';
  }

  isValidDSN(dsn: string): boolean {
    try {
      const url = new URL(dsn);
      return url.protocol === 'sqlserver:';
    } catch (e) {
      return false;
    }
  }
}

/**
 * SQL Server connector
 */
export class SQLServerConnector implements Connector {
  id = 'sqlserver';
  name = 'SQL Server';
  dsnParser = new SQLServerDSNParser();

  private connection?: sql.ConnectionPool;
  private config?: sql.config;

  async connect(dsn: string): Promise<void> {
    try {
      this.config = await this.dsnParser.parse(dsn);

      if (!this.config.options) {
        this.config.options = {};
      }

      this.connection = await new sql.ConnectionPool(this.config).connect();
    } catch (error) {
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = undefined;
    }
  }

  async getSchemas(): Promise<string[]> {
    if (!this.connection) {
      throw new Error('Not connected to SQL Server database');
    }

    try {
      const result = await this.connection.request().query(`
          SELECT SCHEMA_NAME
          FROM INFORMATION_SCHEMA.SCHEMATA
          ORDER BY SCHEMA_NAME
      `);

      return result.recordset.map((row: { SCHEMA_NAME: any }) => row.SCHEMA_NAME);
    } catch (error) {
      throw new Error(`Failed to get schemas: ${(error as Error).message}`);
    }
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.connection) {
      throw new Error('Not connected to SQL Server database');
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      // This is the default schema for SQL Server databases
      const schemaToUse = schema || 'dbo';

      const request = this.connection.request().input('schema', sql.VarChar, schemaToUse);

      const query = `
          SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = @schema
          ORDER BY TABLE_NAME
      `;

      const result = await request.query(query);

      return result.recordset.map((row: { TABLE_NAME: any }) => row.TABLE_NAME);
    } catch (error) {
      throw new Error(`Failed to get tables: ${(error as Error).message}`);
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.connection) {
      throw new Error('Not connected to SQL Server database');
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || 'dbo';

      const request = this.connection
        .request()
        .input('tableName', sql.VarChar, tableName)
        .input('schema', sql.VarChar, schemaToUse);

      const query = `
          SELECT COUNT(*) as count
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_NAME = @tableName
            AND TABLE_SCHEMA = @schema
      `;

      const result = await request.query(query);

      return result.recordset[0].count > 0;
    } catch (error) {
      throw new Error(`Failed to check if table exists: ${(error as Error).message}`);
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.connection) {
      throw new Error('Not connected to SQL Server database');
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || 'dbo';

      const request = this.connection
        .request()
        .input('tableName', sql.VarChar, tableName)
        .input('schema', sql.VarChar, schemaToUse);

      // This gets all indexes including primary keys
      const query = `
          SELECT i.name AS index_name,
                 i.is_unique,
                 i.is_primary_key,
                 c.name AS column_name,
                 ic.key_ordinal
          FROM sys.indexes i
                   INNER JOIN
               sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                   INNER JOIN
               sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                   INNER JOIN
               sys.tables t ON i.object_id = t.object_id
                   INNER JOIN
               sys.schemas s ON t.schema_id = s.schema_id
          WHERE t.name = @tableName
            AND s.name = @schema
          ORDER BY i.name,
                   ic.key_ordinal
      `;

      const result = await request.query(query);

      // Group by index name to collect all columns for each index
      const indexMap = new Map<
        string,
        {
          columns: string[];
          is_unique: boolean;
          is_primary: boolean;
        }
      >();

      for (const row of result.recordset) {
        const indexName = row.index_name;
        const columnName = row.column_name;
        const isUnique = !!row.is_unique;
        const isPrimary = !!row.is_primary_key;

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

      // Convert Map to array of TableIndex objects
      const indexes: TableIndex[] = [];
      indexMap.forEach((info, name) => {
        indexes.push({
          index_name: name,
          column_names: info.columns,
          is_unique: info.is_unique,
          is_primary: info.is_primary,
        });
      });

      return indexes;
    } catch (error) {
      throw new Error(`Failed to get indexes for table ${tableName}: ${(error as Error).message}`);
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.connection) {
      throw new Error('Not connected to SQL Server database');
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || 'dbo';

      const request = this.connection
        .request()
        .input('tableName', sql.VarChar, tableName)
        .input('schema', sql.VarChar, schemaToUse);

      const query = `
          SELECT COLUMN_NAME as    column_name,
                 DATA_TYPE as      data_type,
                 IS_NULLABLE as    is_nullable,
                 COLUMN_DEFAULT as column_default
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = @tableName
            AND TABLE_SCHEMA = @schema
          ORDER BY ORDINAL_POSITION
      `;

      const result = await request.query(query);

      return result.recordset;
    } catch (error) {
      throw new Error(`Failed to get schema for table ${tableName}: ${(error as Error).message}`);
    }
  }

  async getStoredProcedures(schema?: string): Promise<string[]> {
    if (!this.connection) {
      throw new Error('Not connected to SQL Server database');
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || 'dbo';

      const request = this.connection.request().input('schema', sql.VarChar, schemaToUse);

      const query = `
          SELECT ROUTINE_NAME
          FROM INFORMATION_SCHEMA.ROUTINES
          WHERE ROUTINE_SCHEMA = @schema
            AND (ROUTINE_TYPE = 'PROCEDURE' OR ROUTINE_TYPE = 'FUNCTION')
          ORDER BY ROUTINE_NAME
      `;

      const result = await request.query(query);
      return result.recordset.map((row: { ROUTINE_NAME: any }) => row.ROUTINE_NAME);
    } catch (error) {
      throw new Error(`Failed to get stored procedures: ${(error as Error).message}`);
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.connection) {
      throw new Error('Not connected to SQL Server database');
    }

    try {
      // In SQL Server, use 'dbo' as the default schema if none specified
      const schemaToUse = schema || 'dbo';

      const request = this.connection
        .request()
        .input('procedureName', sql.VarChar, procedureName)
        .input('schema', sql.VarChar, schemaToUse);

      // First, get basic procedure information
      const routineQuery = `
          SELECT ROUTINE_NAME as procedure_name,
                 ROUTINE_TYPE,
                 DATA_TYPE    as return_data_type
          FROM INFORMATION_SCHEMA.ROUTINES
          WHERE ROUTINE_NAME = @procedureName
            AND ROUTINE_SCHEMA = @schema
      `;

      const routineResult = await request.query(routineQuery);

      if (routineResult.recordset.length === 0) {
        throw new Error(`Stored procedure '${procedureName}' not found in schema '${schemaToUse}'`);
      }

      const routine = routineResult.recordset[0];

      // Next, get parameter information
      const parameterQuery = `
          SELECT PARAMETER_NAME,
                 PARAMETER_MODE,
                 DATA_TYPE,
                 CHARACTER_MAXIMUM_LENGTH,
                 ORDINAL_POSITION
          FROM INFORMATION_SCHEMA.PARAMETERS
          WHERE SPECIFIC_NAME = @procedureName
            AND SPECIFIC_SCHEMA = @schema
          ORDER BY ORDINAL_POSITION
      `;

      const parameterResult = await request.query(parameterQuery);

      // Format the parameter list
      let parameterList = '';
      if (parameterResult.recordset.length > 0) {
        parameterList = parameterResult.recordset
          .map(
            (param: { CHARACTER_MAXIMUM_LENGTH: number; PARAMETER_NAME: any; PARAMETER_MODE: any; DATA_TYPE: any }) => {
              const lengthStr = param.CHARACTER_MAXIMUM_LENGTH > 0 ? `(${param.CHARACTER_MAXIMUM_LENGTH})` : '';
              return `${param.PARAMETER_NAME} ${param.PARAMETER_MODE} ${param.DATA_TYPE}${lengthStr}`;
            }
          )
          .join(', ');
      }

      // Get the procedure definition from sys.sql_modules
      const definitionQuery = `
          SELECT definition
          FROM sys.sql_modules sm
                   JOIN sys.objects o ON sm.object_id = o.object_id
                   JOIN sys.schemas s ON o.schema_id = s.schema_id
          WHERE o.name = @procedureName
            AND s.name = @schema
      `;

      const definitionResult = await request.query(definitionQuery);
      let definition = undefined;

      if (definitionResult.recordset.length > 0) {
        definition = definitionResult.recordset[0].definition;
      }

      return {
        procedure_name: routine.procedure_name,
        procedure_type: routine.ROUTINE_TYPE === 'PROCEDURE' ? 'procedure' : 'function',
        language: 'sql', // SQL Server procedures are typically in T-SQL
        parameter_list: parameterList,
        return_type: routine.ROUTINE_TYPE === 'FUNCTION' ? routine.return_data_type : undefined,
        definition: definition,
      };
    } catch (error) {
      throw new Error(`Failed to get stored procedure details: ${(error as Error).message}`);
    }
  }

  async executeQuery(query: string): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error('Not connected to SQL Server database');
    }

    const safetyCheck = this.validateQuery(query);
    if (!safetyCheck.isValid) {
      throw new Error(safetyCheck.message || 'Query validation failed');
    }

    try {
      const result = await this.connection.request().query(query);
      return {
        rows: result.recordset || [],
        fields:
          result.recordset && result.recordset.length > 0
            ? Object.keys(result.recordset[0]).map((key) => ({
                name: key,
              }))
            : [],
        rowCount: result.rowsAffected[0] || 0,
      };
    } catch (error) {
      throw new Error(`Failed to execute query: ${(error as Error).message}`);
    }
  }

  validateQuery(query: string): { isValid: boolean; message?: string } {
    // Basic check to prevent non-SELECT queries
    const normalizedQuery = query.trim().toLowerCase();
    if (!allowedKeywords.some((keyword: string) => normalizedQuery.startsWith(keyword))) {
      return {
        isValid: false,
        message: 'Only SELECT queries are allowed for security reasons.',
      };
    }
    return { isValid: true };
  }
}

// Create and register the connector
const sqlServerConnector = new SQLServerConnector();
ConnectorRegistry.register(sqlServerConnector);
