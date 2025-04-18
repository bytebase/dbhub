import pg from 'pg';
const { Pool } = pg;
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
 * PostgreSQL DSN Parser
 * Handles DSN strings like: postgres://user:password@localhost:5432/dbname?sslmode=disable
 */
class PostgresDSNParser implements DSNParser {
  async parse(dsn: string): Promise<pg.PoolConfig> {
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      throw new Error(`Invalid PostgreSQL DSN: ${dsn}`);
    }

    try {
      // For PostgreSQL, we can actually pass the DSN directly to the Pool constructor
      // But we'll parse it here for consistency and to extract components if needed
      const url = new URL(dsn);

      const config: pg.PoolConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 5432,
        database: url.pathname.substring(1), // Remove leading '/'
        user: url.username,
        password: url.password ? decodeURIComponent(url.password) : '',
      };

      // Handle query parameters (like sslmode, etc.)
      url.searchParams.forEach((value, key) => {
        if (key === 'sslmode') {
          config.ssl = value !== 'disable';
        }
        // Add other parameters as needed
      });

      return config;
    } catch (error) {
      throw new Error(`Failed to parse PostgreSQL DSN: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getSampleDSN(): string {
    return 'postgres://postgres:password@localhost:5432/postgres?sslmode=disable';
  }

  isValidDSN(dsn: string): boolean {
    try {
      const url = new URL(dsn);
      return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
    } catch (error) {
      return false;
    }
  }
}

/**
 * PostgreSQL Connector Implementation
 */
export class PostgresConnector implements Connector {
  id = 'postgres';
  name = 'PostgreSQL';
  dsnParser = new PostgresDSNParser();

  private pool: pg.Pool | null = null;

  async connect(dsn: string): Promise<void> {
    try {
      const config = await this.dsnParser.parse(dsn);
      this.pool = new Pool(config);

      // Test the connection
      const client = await this.pool.connect();
      console.error('Successfully connected to PostgreSQL database');
      client.release();
    } catch (err) {
      console.error('Failed to connect to PostgreSQL database:', err);
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

    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY schema_name
      `);

      return result.rows.map((row) => row.schema_name);
    } finally {
      client.release();
    }
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      // 'public' is the standard default schema in PostgreSQL databases
      const schemaToUse = schema || 'public';

      const result = await client.query(
        `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = $1
        ORDER BY table_name
      `,
        [schemaToUse]
      );

      return result.rows.map((row) => row.table_name);
    } finally {
      client.release();
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || 'public';

      const result = await client.query(
        `
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )
      `,
        [schemaToUse, tableName]
      );

      return result.rows[0].exists;
    } finally {
      client.release();
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || 'public';

      // Query to get all indexes for the table
      const result = await client.query(
        `
        SELECT 
          i.relname as index_name,
          array_agg(a.attname) as column_names,
          ix.indisunique as is_unique,
          ix.indisprimary as is_primary
        FROM 
          pg_class t,
          pg_class i,
          pg_index ix,
          pg_attribute a,
          pg_namespace ns
        WHERE 
          t.oid = ix.indrelid
          AND i.oid = ix.indexrelid
          AND a.attrelid = t.oid
          AND a.attnum = ANY(ix.indkey)
          AND t.relkind = 'r'
          AND t.relname = $1
          AND ns.oid = t.relnamespace
          AND ns.nspname = $2
        GROUP BY 
          i.relname, 
          ix.indisunique,
          ix.indisprimary
        ORDER BY 
          i.relname
      `,
        [tableName, schemaToUse]
      );

      return result.rows.map((row) => ({
        index_name: row.index_name,
        column_names: row.column_names,
        is_unique: row.is_unique,
        is_primary: row.is_primary,
      }));
    } finally {
      client.release();
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      // Tables are created in the 'public' schema by default unless otherwise specified
      const schemaToUse = schema || 'public';

      // Get table columns
      const result = await client.query(
        `
        SELECT 
          column_name, 
          data_type, 
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_schema = $1
        AND table_name = $2
        ORDER BY ordinal_position
      `,
        [schemaToUse, tableName]
      );

      return result.rows;
    } finally {
      client.release();
    }
  }

  async getStoredProcedures(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || 'public';

      // Get stored procedures and functions from PostgreSQL
      const result = await client.query(
        `
        SELECT 
          routine_name
        FROM information_schema.routines
        WHERE routine_schema = $1
        ORDER BY routine_name
      `,
        [schemaToUse]
      );

      return result.rows.map((row) => row.routine_name);
    } finally {
      client.release();
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || 'public';

      // Get stored procedure details from PostgreSQL
      const result = await client.query(
        `
        SELECT 
          routine_name as procedure_name,
          routine_type,
          CASE WHEN routine_type = 'PROCEDURE' THEN 'procedure' ELSE 'function' END as procedure_type,
          external_language as language,
          data_type as return_type,
          routine_definition as definition,
          (
            SELECT string_agg(
              parameter_name || ' ' || 
              parameter_mode || ' ' || 
              data_type,
              ', '
            )
            FROM information_schema.parameters
            WHERE specific_schema = $1
            AND specific_name = $2
            AND parameter_name IS NOT NULL
          ) as parameter_list
        FROM information_schema.routines
        WHERE routine_schema = $1
        AND routine_name = $2
      `,
        [schemaToUse, procedureName]
      );

      if (result.rows.length === 0) {
        throw new Error(`Stored procedure '${procedureName}' not found in schema '${schemaToUse}'`);
      }

      const procedure = result.rows[0];

      // If routine_definition is NULL, try to get the procedure body with pg_get_functiondef
      let definition = procedure.definition;

      try {
        // Get the OID for the procedure/function
        const oidResult = await client.query(
          `
          SELECT p.oid, p.prosrc
          FROM pg_proc p
          JOIN pg_namespace n ON p.pronamespace = n.oid
          WHERE p.proname = $1
          AND n.nspname = $2
        `,
          [procedureName, schemaToUse]
        );

        if (oidResult.rows.length > 0) {
          // If definition is still null, get the full definition
          if (!definition) {
            const oid = oidResult.rows[0].oid;
            const defResult = await client.query(`SELECT pg_get_functiondef($1)`, [oid]);
            if (defResult.rows.length > 0) {
              definition = defResult.rows[0].pg_get_functiondef;
            } else {
              // Fall back to prosrc if pg_get_functiondef fails
              definition = oidResult.rows[0].prosrc;
            }
          }
        }
      } catch (err) {
        // Ignore errors trying to get definition - it's optional
        console.error(`Error getting procedure definition: ${err}`);
      }

      return {
        procedure_name: procedure.procedure_name,
        procedure_type: procedure.procedure_type,
        language: procedure.language || 'sql',
        parameter_list: procedure.parameter_list || '',
        return_type: procedure.return_type !== 'void' ? procedure.return_type : undefined,
        definition: definition || undefined,
      };
    } finally {
      client.release();
    }
  }

  async executeQuery(query: string): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }

    const safetyCheck = this.validateQuery(query);
    if (!safetyCheck.isValid) {
      throw new Error(safetyCheck.message || 'Query validation failed');
    }

    const client = await this.pool.connect();
    try {
      return await client.query(query);
    } finally {
      client.release();
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
const postgresConnector = new PostgresConnector();
ConnectorRegistry.register(postgresConnector);
