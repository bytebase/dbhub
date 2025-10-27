import { ConnectorManager } from "../connectors/manager.js";
import {
  createResourceSuccessResponse,
  createResourceErrorResponse,
} from "../utils/response-formatter.js";

/**
 * Indexes resource handler
 * Returns information about indexes on a table
 */
export async function indexesResourceHandler(uri: URL, variables: any, databaseId?: string, _extra?: any) {
  const connector = databaseId ? ConnectorManager.getConnector(databaseId) : ConnectorManager.getCurrentConnector();

  // Extract schema and table names from URL variables
  const schemaName =
    variables && variables.schemaName
      ? Array.isArray(variables.schemaName)
        ? variables.schemaName[0]
        : variables.schemaName
      : undefined;

  const tableName =
    variables && variables.tableName
      ? Array.isArray(variables.tableName)
        ? variables.tableName[0]
        : variables.tableName
      : undefined;

  if (!tableName) {
    return createResourceErrorResponse(uri.href, "Table name is required", "MISSING_TABLE_NAME");
  }

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

    // Check if table exists
    const tableExists = await connector.tableExists(tableName, schemaName);
    if (!tableExists) {
      return createResourceErrorResponse(
        uri.href,
        `Table '${tableName}' does not exist in schema '${schemaName || "default"}'`,
        "TABLE_NOT_FOUND"
      );
    }

    // Get indexes for the table
    const indexes = await connector.getTableIndexes(tableName, schemaName);

    // Prepare response data
    const responseData = {
      table: tableName,
      schema: schemaName,
      indexes: indexes,
      count: indexes.length,
      database: databaseId || "default"
    };

    // Use the utility to create a standardized response
    return createResourceSuccessResponse(uri.href, responseData);
  } catch (error) {
    return createResourceErrorResponse(
      uri.href,
      `Error retrieving indexes: ${(error as Error).message}`,
      "INDEXES_RETRIEVAL_ERROR"
    );
  }
}
