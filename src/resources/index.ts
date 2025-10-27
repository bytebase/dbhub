import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tablesResourceHandler } from "./tables.js";
import { tableStructureResourceHandler } from "./schema.js";
import { schemasResourceHandler } from "./schemas.js";
import { indexesResourceHandler } from "./indexes.js";
import { proceduresResourceHandler, procedureDetailResourceHandler } from "./procedures.js";

// Export all resource handlers
export { tablesResourceHandler } from "./tables.js";
export { tableStructureResourceHandler } from "./schema.js";
export { schemasResourceHandler } from "./schemas.js";
export { indexesResourceHandler } from "./indexes.js";
export { proceduresResourceHandler, procedureDetailResourceHandler } from "./procedures.js";

/**
 * Register all resource handlers with the MCP server
 */
export function registerResources(server: McpServer, databaseId?: string): void {
  // Resource for listing all schemas
  server.resource("schemas", "db://schemas", (uri, variables, extra) =>
    schemasResourceHandler(uri, databaseId, extra)
  );

  // Allow listing tables within a specific schema
  server.resource(
    "tables_in_schema",
    new ResourceTemplate("db://schemas/{schemaName}/tables", { list: undefined }),
    (uri, variables, extra) =>
      tablesResourceHandler(uri, variables, databaseId, extra)
  );

  // Resource for getting table structure within a specific database schema
  server.resource(
    "table_structure_in_schema",
    new ResourceTemplate("db://schemas/{schemaName}/tables/{tableName}", { list: undefined }),
    (uri, variables, extra) =>
      tableStructureResourceHandler(uri, variables, databaseId, extra)
  );

  // Resource for getting indexes for a table within a specific database schema
  server.resource(
    "indexes_in_table",
    new ResourceTemplate("db://schemas/{schemaName}/tables/{tableName}/indexes", {
      list: undefined,
    }),
    (uri, variables, extra) =>
      indexesResourceHandler(uri, variables, databaseId, extra)
  );

  // Resource for listing stored procedures within a schema
  server.resource(
    "procedures_in_schema",
    new ResourceTemplate("db://schemas/{schemaName}/procedures", { list: undefined }),
    (uri, variables, extra) =>
      proceduresResourceHandler(uri, variables, databaseId, extra)
  );

  // Resource for getting procedure detail within a schema
  server.resource(
    "procedure_detail_in_schema",
    new ResourceTemplate("db://schemas/{schemaName}/procedures/{procedureName}", {
      list: undefined,
    }),
    (uri, variables, extra) =>
      procedureDetailResourceHandler(uri, variables, databaseId, extra)
  );
}
