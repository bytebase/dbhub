import { ConnectorManager } from "../connectors/manager.js";
import { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  createResourceSuccessResponse,
  createResourceErrorResponse,
} from "../utils/response-formatter.js";

/**
 * Schema resource handler
 * Returns schema information for a specific table, optionally within a specific database schema
 */
export async function tableStructureResourceHandler(uri: URL, variables: Variables, databaseId?: string, _extra?: any) {
  const connector = databaseId ? ConnectorManager.getConnector(databaseId) : ConnectorManager.getCurrentConnector();

  // Handle tableName which could be a string or string array from URL template
  const tableName = Array.isArray(variables.tableName)
    ? variables.tableName[0]
    : (variables.tableName as string);

  // Extract schemaName if present
  const schemaName = variables.schemaName
    ? Array.isArray(variables.schemaName)
      ? variables.schemaName[0]
      : (variables.schemaName as string)
    : undefined;

  try {
    // If a schema name was provided, verify that it exists
    if (schemaName) {
      const availableSchemas = await connector.getSchemas();
      if (!availableSchemas.includes(schemaName)) {
        return createResourceErrorResponse(
          uri.href,
          `Schema '${schemaName}' does not exist or cannot be accessed`,
          "SCHEMA_NOT_FOUND"
        );
      }
    }

    // Check if the table exists in the schema before getting its structure
    const tableExists = await connector.tableExists(tableName, schemaName);
    if (!tableExists) {
      const schemaInfo = schemaName ? ` in schema '${schemaName}'` : "";
      return createResourceErrorResponse(
        uri.href,
        `Table '${tableName}'${schemaInfo} does not exist or cannot be accessed`,
        "TABLE_NOT_FOUND"
      );
    }

    // Get the table schema now that we know it exists
    const columns = await connector.getTableSchema(tableName, schemaName);

    // Create a more structured response
    const formattedColumns = columns.map((col) => ({
      name: col.column_name,
      type: col.data_type,
      nullable: col.is_nullable === "YES",
      default: col.column_default,
    }));

    // Prepare response data
    const responseData = {
      table: tableName,
      schema: schemaName,
      columns: formattedColumns,
      count: formattedColumns.length,
      database: databaseId || "default"
    };

    // Use the utility to create a standardized response
    return createResourceSuccessResponse(uri.href, responseData);
  } catch (error) {
    // Handle any other errors that might occur
    return createResourceErrorResponse(
      uri.href,
      `Error retrieving schema: ${(error as Error).message}`,
      "SCHEMA_RETRIEVAL_ERROR"
    );
  }
}
