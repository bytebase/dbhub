import pg from "pg";
const { Pool } = pg;
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
 * PostgreSQL DSN Parser
 * Handles DSN strings like: postgres://user:password@localhost:5432/dbname?sslmode=disable
 * Supported SSL modes:
 * - sslmode=disable: No SSL
 * - sslmode=require: SSL connection without certificate verification
 * - Any other value: SSL with certificate verification
 */
class PostgresDSNParser implements DSNParser {
  async parse(dsn: string): Promise<pg.PoolConfig> {
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid PostgreSQL DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      // Use the SafeURL helper instead of the built-in URL
      // This will handle special characters in passwords, etc.
      const url = new SafeURL(dsn);

      const config: pg.PoolConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 5432,
        database: url.pathname ? url.pathname.substring(1) : '', // Remove leading '/' if exists
        user: url.username,
        password: url.password,
      };

      // Handle query parameters (like sslmode, etc.)
      url.forEachSearchParam((value, key) => {
        if (key === "sslmode") {
          if (value === "disable") {
            config.ssl = false;
          } else if (value === "require") {
            config.ssl = { rejectUnauthorized: false };
          } else {
            config.ssl = true;
          }
        }
        // Add other parameters as needed
      });

      return config;
    } catch (error) {
      throw new Error(
        `Failed to parse PostgreSQL DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "postgres://postgres:password@localhost:5432/postgres?sslmode=require";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith('postgres://') || dsn.startsWith('postgresql://');
    } catch (error) {
      return false;
    }
  }
}

/**
 * PostgreSQL Connector Implementation
 */
export class PostgresConnector implements Connector {
  id: ConnectorType = "postgres";
  name = "PostgreSQL";
  dsnParser = new PostgresDSNParser();

  private pool: pg.Pool | null = null;

  async connect(dsn: string): Promise<void> {
    try {
      const config = await this.dsnParser.parse(dsn);
      this.pool = new Pool(config);

      // Test the connection
      const client = await this.pool.connect();
      console.error("Successfully connected to PostgreSQL database");
      client.release();
    } catch (err) {
      console.error("Failed to connect to PostgreSQL database:", err);
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
      throw new Error("Not connected to database");
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
      throw new Error("Not connected to database");
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      // 'public' is the standard default schema in PostgreSQL databases
      const schemaToUse = schema || "public";

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
      throw new Error("Not connected to database");
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || "public";

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
      throw new Error("Not connected to database");
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || "public";

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
      throw new Error("Not connected to database");
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      // Tables are created in the 'public' schema by default unless otherwise specified
      const schemaToUse = schema || "public";

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
      throw new Error("Not connected to database");
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || "public";

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
      throw new Error("Not connected to database");
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || "public";

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
        language: procedure.language || "sql",
        parameter_list: procedure.parameter_list || "",
        return_type: procedure.return_type !== "void" ? procedure.return_type : undefined,
        definition: definition || undefined,
      };
    } finally {
      client.release();
    }
  }

  async executeSQL(sql: string): Promise<SQLResult> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    const client = await this.pool.connect();
    try {
      // Check if this is a multi-statement query
      const statements = sql.split(';')
        .map(statement => statement.trim())
        .filter(statement => statement.length > 0);

      if (statements.length === 1) {
        // Single statement
        return await client.query(statements[0]);
      } else {
        // Multiple statements - execute all in same session for transaction consistency
        let allRows: any[] = [];
        
        // Execute within a transaction to ensure session consistency
        await client.query('BEGIN');
        try {
          for (const statement of statements) {
            const result = await client.query(statement);
            // Collect rows from SELECT/WITH/EXPLAIN statements
            if (result.rows && result.rows.length > 0) {
              allRows.push(...result.rows);
            }
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }

        return { rows: allRows };
      }
    } finally {
      client.release();
    }
  }
}

// Create and register the connector
const postgresConnector = new PostgresConnector();
ConnectorRegistry.register(postgresConnector);
