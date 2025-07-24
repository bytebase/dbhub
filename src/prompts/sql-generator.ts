import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import {
  formatPromptSuccessResponse,
  formatPromptErrorResponse,
} from "../utils/response-formatter.js";
import { SQLDialect } from "../types/sql.js";

// Schema for SQL generator prompt
export const sqlGeneratorSchema = {
  description: z.string().describe("Natural language description of the SQL query to generate"),
  schema: z.string().optional().describe("Optional database schema to use"),
};

/**
 * SQL Generator Prompt Handler
 * Generates SQL queries from natural language descriptions
 */
export async function sqlGeneratorPromptHandler(
  {
    description,
    schema,
  }: {
    description: string;
    schema?: string;
  },
  _extra: any
) {
  try {
    // Get current connector to determine dialect
    const connector = ConnectorManager.getCurrentConnector();

    // Determine SQL dialect from connector automatically
    let sqlDialect: SQLDialect;
    switch (connector.id) {
      case "postgres":
        sqlDialect = "postgres";
        break;
      case "sqlite":
        sqlDialect = "sqlite";
        break;
      case "mysql":
        sqlDialect = "mysql";
        break;
      case "sqlserver":
        sqlDialect = "mssql";
        break;
      case "dameng":
        sqlDialect = "dameng";
        break;
      default:
        sqlDialect = "ansi"; // Default to standard SQL if connector type is unknown
    }

    // Verify schema exists if provided
    if (schema) {
      const availableSchemas = await connector.getSchemas();
      if (!availableSchemas.includes(schema)) {
        return formatPromptErrorResponse(
          `Schema '${schema}' does not exist or cannot be accessed. Available schemas: ${availableSchemas.join(", ")}`,
          "SCHEMA_NOT_FOUND"
        );
      }
    }

    // Get schema information to help with table/column references
    try {
      const tables = await connector.getTables(schema);

      if (tables.length === 0) {
        const schemaInfo = schema ? `in schema '${schema}'` : "in the database";
        return formatPromptErrorResponse(
          `No tables found ${schemaInfo}. Please check your database connection or schema name.`,
          "NO_TABLES_FOUND"
        );
      }

      const tableSchemas = await Promise.all(
        tables.map(async (table) => {
          try {
            const columns = await connector.getTableSchema(table, schema);
            return {
              table,
              columns: columns.map((col) => ({
                name: col.column_name,
                type: col.data_type,
              })),
            };
          } catch (error) {
            // Skip tables we can't access
            return null;
          }
        })
      );

      // Filter out null entries (tables we couldn't access)
      const accessibleSchemas = tableSchemas.filter((schema) => schema !== null);

      if (accessibleSchemas.length === 0) {
        return formatPromptErrorResponse(
          `No accessible tables found. You may not have sufficient permissions to access table schemas.`,
          "NO_ACCESSIBLE_TABLES"
        );
      }

      // Generate a schema description for context
      const schemaContext =
        accessibleSchemas.length > 0
          ? `Available tables and their columns:\n${accessibleSchemas
              .map(
                (schema) =>
                  `- ${schema!.table}: ${schema!.columns
                    .map((col) => `${col.name} (${col.type})`)
                    .join(", ")}`
              )
              .join("\n")}`
          : "No schema information available.";

      // Example queries for the given dialect to use as reference
      const dialectExamples: Record<SQLDialect, string[]> = {
        postgres: [
          "SELECT * FROM users WHERE created_at > NOW() - INTERVAL '1 day'",
          "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name HAVING COUNT(o.id) > 5",
          "SELECT product_name, price FROM products WHERE price > (SELECT AVG(price) FROM products)",
        ],
        sqlite: [
          "SELECT * FROM users WHERE created_at > datetime('now', '-1 day')",
          "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name HAVING COUNT(o.id) > 5",
          "SELECT product_name, price FROM products WHERE price > (SELECT AVG(price) FROM products)",
        ],
        mysql: [
          "SELECT * FROM users WHERE created_at > NOW() - INTERVAL 1 DAY",
          "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name HAVING COUNT(o.id) > 5",
          "SELECT product_name, price FROM products WHERE price > (SELECT AVG(price) FROM products)",
        ],
        mssql: [
          "SELECT * FROM users WHERE created_at > DATEADD(day, -1, GETDATE())",
          "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name HAVING COUNT(o.id) > 5",
          "SELECT product_name, price FROM products WHERE price > (SELECT AVG(price) FROM products)",
        ],
        dameng: [
          "SELECT * FROM users WHERE created_at > SYSDATE - INTERVAL '1' DAY",
          "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name HAVING COUNT(o.id) > 5",
          "SELECT product_name, price FROM products WHERE price > (SELECT AVG(price) FROM products)",
          "SELECT DISTINCT OWNER AS SCHEMA_NAME FROM ALL_OBJECTS WHERE OWNER NOT IN ('SYS','SYSDBA')"
        ],
        ansi: [
          "SELECT * FROM users WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '1' DAY",
          "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name HAVING COUNT(o.id) > 5",
          "SELECT product_name, price FROM products WHERE price > (SELECT AVG(price) FROM products)",
        ],
      };

      // Build a prompt that would help generate the SQL
      // In a real implementation, this would call an AI model
      const schemaInfo = schema ? `in schema '${schema}'` : "across all schemas";
      const prompt = `
Generate a ${sqlDialect} SQL query based on this description: "${description}"

${schemaContext}
Working ${schemaInfo}

The query should:
1. Be written for ${sqlDialect} dialect
2. Use only the available tables and columns
3. Prioritize readability
4. Include appropriate comments
5. Be compatible with ${sqlDialect} syntax
`;

      // In a real implementation, this would be the result from an AI model call
      // For this demo, we'll generate a simple SQL query based on the description
      let generatedSQL: string;

      // Very simple pattern matching for demo purposes
      // In a real implementation, this would use a language model
      if (description.toLowerCase().includes("count")) {
        const schemaPrefix = schema ? `-- Schema: ${schema}\n` : "";
        generatedSQL = `${schemaPrefix}-- Count query generated from: "${description}"
SELECT COUNT(*) AS count 
FROM ${accessibleSchemas.length > 0 ? accessibleSchemas[0]!.table : "table_name"};`;
      } else if (
        description.toLowerCase().includes("average") ||
        description.toLowerCase().includes("avg")
      ) {
        const table = accessibleSchemas.length > 0 ? accessibleSchemas[0]!.table : "table_name";
        const numericColumn =
          accessibleSchemas.length > 0
            ? accessibleSchemas[0]!.columns.find((col) =>
                ["int", "numeric", "decimal", "float", "real", "double"].some((t) =>
                  col.type.includes(t)
                )
              )?.name || "numeric_column"
            : "numeric_column";

        const schemaPrefix = schema ? `-- Schema: ${schema}\n` : "";
        generatedSQL = `${schemaPrefix}-- Average query generated from: "${description}"
SELECT AVG(${numericColumn}) AS average
FROM ${table};`;
      } else if (description.toLowerCase().includes("join")) {
        const schemaPrefix = schema ? `-- Schema: ${schema}\n` : "";
        generatedSQL = `${schemaPrefix}-- Join query generated from: "${description}"
SELECT t1.*, t2.*
FROM ${accessibleSchemas.length > 0 ? accessibleSchemas[0]?.table : "table1"} t1
JOIN ${accessibleSchemas.length > 1 ? accessibleSchemas[1]?.table : "table2"} t2
  ON t1.id = t2.${accessibleSchemas.length > 0 ? accessibleSchemas[0]?.table : "table1"}_id;`;
      } else {
        // Default to a simple SELECT
        const table = accessibleSchemas.length > 0 ? accessibleSchemas[0]!.table : "table_name";
        const schemaPrefix = schema ? `-- Schema: ${schema}\n` : "";
        generatedSQL = `${schemaPrefix}-- Query generated from: "${description}"
SELECT * 
FROM ${table}
LIMIT 10;`;
      }

      // Return the generated SQL with explanations
      return formatPromptSuccessResponse(
        generatedSQL,
        // Add references to example queries that could help
        dialectExamples[sqlDialect]
      );
    } catch (error) {
      return formatPromptErrorResponse(
        `Error generating SQL query schema information: ${(error as Error).message}`,
        "SCHEMA_RETRIEVAL_ERROR"
      );
    }
  } catch (error) {
    return formatPromptErrorResponse(
      `Failed to generate SQL: ${(error as Error).message}`,
      "SQL_GENERATION_ERROR"
    );
  }
}
