/**
 * Tool Handler Helpers
 * Shared utilities for MCP tool handlers to reduce boilerplate
 */

import { ConnectorType } from "../connectors/interface.js";
import { isReadOnlySQL, allowedKeywords } from "./allowed-keywords.js";
import { requestStore } from "../requests/index.js";
import { getClientIdentifier } from "./client-identifier.js";

/**
 * Request metadata for tracking
 */
export interface RequestMetadata {
  sourceId: string;
  toolName: string;
  sql: string;
}

/**
 * Normalize source ID to handle optional parameter
 * @param sourceId Optional source ID from tool arguments
 * @returns Effective source ID ("default" if not provided)
 */
export function getEffectiveSourceId(sourceId?: string): string {
  return sourceId || "default";
}

/**
 * Re-export isReadOnlySQL for readonly mode validation
 * Checks if SQL statement is read-only (SELECT, WITH, etc.)
 */
export { isReadOnlySQL as isAllowedInReadonlyMode };

/**
 * Create a readonly violation error message
 * @param toolName Tool name for error message
 * @param sourceId Source ID for error message
 * @param connectorType Database connector type
 * @returns Formatted error message
 */
export function createReadonlyViolationMessage(
  toolName: string,
  sourceId: string,
  connectorType: ConnectorType
): string {
  return `Tool '${toolName}' cannot execute in readonly mode for source '${sourceId}'. Only read-only SQL operations are allowed: ${allowedKeywords[connectorType]?.join(", ") || "none"}`;
}

/**
 * Track a tool request in the request store
 * @param metadata Request metadata (sourceId, toolName, sql)
 * @param startTime Request start timestamp
 * @param extra MCP extra context for client identification
 * @param success Whether the request succeeded
 * @param error Optional error message
 */
export function trackToolRequest(
  metadata: RequestMetadata,
  startTime: number,
  extra: any,
  success: boolean,
  error?: string
): void {
  requestStore.add({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sourceId: metadata.sourceId,
    toolName: metadata.toolName,
    sql: metadata.sql,
    durationMs: Date.now() - startTime,
    client: getClientIdentifier(extra),
    success,
    error,
  });
}

/**
 * Higher-order function to wrap tool handlers with automatic request tracking
 * @param handler Core handler logic that performs the actual work
 * @param getMetadata Function to extract request metadata from args and result
 * @returns Wrapped handler with automatic request tracking
 */
export function withRequestTracking<TArgs = any, TResult = any>(
  handler: (args: TArgs, extra: any) => Promise<TResult>,
  getMetadata: (args: TArgs, result?: TResult, error?: Error) => RequestMetadata
) {
  return async (args: TArgs, extra: any): Promise<TResult> => {
    const startTime = Date.now();
    let success = true;
    let errorMessage: string | undefined;
    let result: TResult | undefined;
    let error: Error | undefined;

    try {
      result = await handler(args, extra);
      return result;
    } catch (err) {
      success = false;
      error = err as Error;
      errorMessage = error.message;
      throw err;
    } finally {
      const metadata = getMetadata(args, result, error);
      trackToolRequest(metadata, startTime, extra, success, errorMessage);
    }
  };
}
