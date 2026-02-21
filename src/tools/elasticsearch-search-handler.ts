import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { getEffectiveSourceId, trackToolRequest } from "../utils/tool-handler-helpers.js";

// Schema for elasticsearch_search tool
export const elasticsearchSearchSchema = {
  query: z.string().describe("Elasticsearch query (JSON DSL or simplified syntax). Examples: {\"query\": {\"match_all\": {}}} or {\"query\": {\"term\": {\"status\": \"error\"}}, \"size\": 10}"),
};

/**
 * Create an elasticsearch_search tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to
 * @returns A handler function bound to the specified source
 */
export function createElasticsearchSearchToolHandler(sourceId: string) {
  return async (args: any, extra: any) => {
    const { query } = args as { query: string };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;
    let result: any;

    try {
      // Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(sourceId);

      // Get connector for the specified source
      const connector = ConnectorManager.getCurrentConnector(sourceId);
      
      if (connector.id !== "elasticsearch") {
        throw new Error("This tool only works with Elasticsearch connectors");
      }

      // Execute the Elasticsearch query
      result = await (connector as any).executeCommand(query);

      // Build response data
      const responseData = {
        total_hits: result.hits.total,
        documents: result.hits.documents,
        aggregations: result.aggregations,
        source_id: effectiveSourceId,
      };

      return createToolSuccessResponse(responseData);
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      // Track the request
      const duration = Date.now() - startTime;
      trackToolRequest({
        sourceId: effectiveSourceId,
        toolName: `elasticsearch_search_${effectiveSourceId}`,
        success,
        duration,
        errorMessage,
      });
    }
  };
}
