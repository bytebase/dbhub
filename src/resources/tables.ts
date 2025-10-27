import { ConnectorManager } from "../connectors/manager.js";
import {
  createResourceSuccessResponse,
  createResourceErrorResponse,
} from "../utils/response-formatter.js";

/**
 * Tables resource handler
 * Returns a list of all tables in the database or within a specific schema
 */
export async function tablesResourceHandler(uri: URL, variables: any, databaseId?: string, _extra?: any) {
  const connector = databaseId ? ConnectorManager.getConnector(databaseId) : ConnectorManager.getCurrentConnector();

  // Extract the schema name from URL variables if present
  const schemaName =
    variables && variables.schemaName
      ? Array.isArray(variables.schemaName)
        ? variables.schemaName[0]
        : variables.schemaName
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

    // Get tables with optional schema filter
    const tableNames = await connector.getTables(schemaName);

    // Prepare response data
    const responseData = {
      tables: tableNames,
      count: tableNames.length,
      schema: schemaName,
      database: databaseId || "default"
    };

    // Use the utility to create a standardized response
    return createResourceSuccessResponse(uri.href, responseData);
  } catch (error) {
    return createResourceErrorResponse(
      uri.href,
      `Error retrieving tables: ${(error as Error).message}`,
      "TABLES_RETRIEVAL_ERROR"
    );
  }
}
