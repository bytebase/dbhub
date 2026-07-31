import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import {
  getEffectiveSourceId,
  trackToolRequest,
  tryClassifyConnectionError,
} from "../utils/tool-handler-helpers.js";

// health_check takes no input - metrics are always for the source the tool
// instance is bound to. See execute-sql.ts for why the raw shape is exported
// separately from the wrapped z.object().
export const healthCheckSchema = {};

export const healthCheckInputSchema = z.object(healthCheckSchema);

/**
 * Create a health_check tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to (undefined for single-source mode)
 * @returns A handler function bound to the specified source
 */
export function createHealthCheckToolHandler(sourceId?: string) {
  return async (_args: any, extra: any) => {
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;

    try {
      await ConnectorManager.ensureConnected(sourceId);
      const connector = ConnectorManager.getCurrentConnector(sourceId);

      if (!connector.getHealthCheck) {
        success = false;
        errorMessage = `health_check is not supported for '${connector.id}' sources yet`;
        return createToolErrorResponse(errorMessage, "UNSUPPORTED");
      }

      const health = await connector.getHealthCheck();

      return createToolSuccessResponse({
        source_id: effectiveSourceId,
        ...(health.connections
          ? {
              connections: {
                total: health.connections.total,
                active: health.connections.active,
                idle: health.connections.idle,
                idle_in_transaction: health.connections.idleInTransaction,
                ...(health.connections.idleInTransactionAborted !== undefined
                  ? { idle_in_transaction_aborted: health.connections.idleInTransactionAborted }
                  : {}),
                max_connections: health.connections.maxConnections,
                longest_idle_in_transaction_seconds: health.connections.longestIdleInTransactionSeconds,
                longest_active_query_seconds: health.connections.longestActiveQuerySeconds,
              },
            }
          : {}),
        ...(health.bufferCache
          ? {
              buffer_cache: {
                hit_ratio_pct: health.bufferCache.hitRatioPct,
                blocks_hit: health.bufferCache.blocksHit,
                blocks_read: health.bufferCache.blocksRead,
              },
            }
          : {}),
        ...(health.notes && health.notes.length > 0 ? { notes: health.notes } : {}),
      });
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      const classified = tryClassifyConnectionError(error, sourceId, effectiveSourceId);
      if (classified) return classified;
      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: effectiveSourceId === "default" ? "health_check" : `health_check_${effectiveSourceId}`,
          sql: "",
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
