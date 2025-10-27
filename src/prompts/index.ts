import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sqlGeneratorPromptHandler, sqlGeneratorSchema } from "./sql-generator.js";
import { dbExplainerPromptHandler, dbExplainerSchema } from "./db-explainer.js";

/**
 * Register all prompt handlers with the MCP server
 */
export function registerPrompts(server: McpServer, databaseId?: string): void {
  // Build prompt names with optional database ID suffix
  const sqlGeneratorName = databaseId ? `generate_sql_${databaseId}` : "generate_sql";
  const dbExplainerName = databaseId ? `explain_db_${databaseId}` : "explain_db";

  // Register SQL Generator prompt
  server.prompt(
    sqlGeneratorName,
    `Generate SQL queries from natural language descriptions for the ${databaseId ? databaseId : 'current'} database`,
    sqlGeneratorSchema,
    (args, extra) => sqlGeneratorPromptHandler(args, extra, databaseId)
  );

  // Register Database Explainer prompt
  server.prompt(
    dbExplainerName,
    `Get explanations about database tables, columns, and structures for the ${databaseId ? databaseId : 'current'} database`,
    dbExplainerSchema,
    (args, extra) => dbExplainerPromptHandler(args, extra, databaseId)
  );
}
