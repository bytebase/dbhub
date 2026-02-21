import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { getEffectiveSourceId, trackToolRequest } from "../utils/tool-handler-helpers.js";

// Schema for redis_command tool
export const redisCommandSchema = {
  command: z.string().describe("Redis command (e.g., GET key, SET key value, HGETALL hash)"),
};

/**
 * Create a redis_command tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to
 * @returns A handler function bound to the specified source
 */
export function createRedisCommandToolHandler(sourceId: string) {
  return async (args: any, extra: any) => {
    const { command } = args as { command: string };
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
      
      if (connector.id !== "redis") {
        throw new Error("This tool only works with Redis connectors");
      }

      // Execute the Redis command
      result = await (connector as any).executeCommand(command);

      // Build response data
      const responseData = {
        value: result.value,
        type: result.type,
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
        toolName: `redis_command_${effectiveSourceId}`,
        success,
        duration,
        errorMessage,
      });
    }
  };
}
