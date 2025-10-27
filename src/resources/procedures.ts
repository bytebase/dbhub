import { ConnectorManager } from "../connectors/manager.js";
import {
  createResourceSuccessResponse,
  createResourceErrorResponse,
} from "../utils/response-formatter.js";

/**
 * Stored procedures/functions resource handler
 * Returns a list of all stored procedures/functions in the database or within a specific schema
 */
export async function proceduresResourceHandler(uri: URL, variables: any, databaseId?: string, _extra?: any) {
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

    // Get stored procedures with optional schema filter
    const procedureNames = await connector.getStoredProcedures(schemaName);

    // Prepare response data
    const responseData = {
      procedures: procedureNames,
      count: procedureNames.length,
      schema: schemaName,
      database: databaseId || "default"
    };

    // Use the utility to create a standardized response
    return createResourceSuccessResponse(uri.href, responseData);
  } catch (error) {
    return createResourceErrorResponse(
      uri.href,
      `Error retrieving stored procedures: ${(error as Error).message}`,
      "PROCEDURES_RETRIEVAL_ERROR"
    );
  }
}

/**
 * Stored procedure/function details resource handler
 * Returns details for a specific stored procedure/function
 */
export async function procedureDetailResourceHandler(uri: URL, variables: any, databaseId?: string, _extra?: any) {
  const connector = databaseId ? ConnectorManager.getConnector(databaseId) : ConnectorManager.getCurrentConnector();

  // Extract parameters from URL variables
  const schemaName =
    variables && variables.schemaName
      ? Array.isArray(variables.schemaName)
        ? variables.schemaName[0]
        : variables.schemaName
      : undefined;

  const procedureName =
    variables && variables.procedureName
      ? Array.isArray(variables.procedureName)
        ? variables.procedureName[0]
        : variables.procedureName
      : undefined;

  // Validate required parameters
  if (!procedureName) {
    return createResourceErrorResponse(uri.href, "Procedure name is required", "MISSING_PARAMETER");
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

    // Get procedure details
    const procedureDetails = await connector.getStoredProcedureDetail(procedureName, schemaName);

    // Prepare response data
    const responseData = {
      procedureName: procedureDetails.procedure_name,
      procedureType: procedureDetails.procedure_type,
      language: procedureDetails.language,
      parameters: procedureDetails.parameter_list,
      returnType: procedureDetails.return_type,
      definition: procedureDetails.definition,
      schema: schemaName,
      database: databaseId || "default"
    };

    // Use the utility to create a standardized response
    return createResourceSuccessResponse(uri.href, responseData);
  } catch (error) {
    return createResourceErrorResponse(
      uri.href,
      `Error retrieving procedure details: ${(error as Error).message}`,
      "PROCEDURE_DETAILS_ERROR"
    );
  }
}
