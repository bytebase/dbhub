/**
 * Tool Handler Helpers
 * Shared utilities for MCP tool handlers to reduce boilerplate
 */

import { ConnectorType } from "../connectors/interface.js";
import { ConnectorManager } from "../connectors/manager.js";
import { isReadOnlySQL } from "./allowed-keywords.js";
import { requestStore } from "../requests/index.js";
import { getClientIdentifier } from "./client-identifier.js";
import { classifyConnectionError } from "./error-classifier.js";
import {
  READONLY_VIOLATION_MESSAGE,
  createGenericExecutionErrorView,
  createSafeToolErrorView,
  type SafeToolErrorView,
} from "./safe-execution-error.js";

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
  _toolName: string,
  _sourceId: string,
  _connectorType: ConnectorType
): string {
  return READONLY_VIOLATION_MESSAGE;
}

/**
 * Track a tool request in the request store
 * @param metadata Request metadata (sourceId, toolName, sql)
 * @param startTime Request start timestamp
 * @param extra MCP extra context for client identification
 * @param success Whether the request succeeded
 * @param requestStoreError Optional stable, safe error string
 */
export function trackToolRequest(
  metadata: RequestMetadata,
  startTime: number,
  extra: any,
  success: boolean,
  requestStoreError?: string
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
    error: requestStoreError,
  });
}

/**
 * If `error` is a recognized connection/access failure for the given source,
 * return a classified tool error response; otherwise return null so the caller
 * falls back to its generic error handling.
 *
 * @param rawSourceId     config lookup key (undefined => default source)
 * @param displaySourceId human-readable id used in the message + details
 */
export function tryClassifyConnectionError(
  error: unknown,
  rawSourceId: string | undefined,
  displaySourceId: string
): SafeToolErrorView | null {
  // Defensive: getSourceConfig throws if the manager is uninitialized. Keep
  // this helper as total as classifyConnectionError itself — never throw from
  // within a caller's catch block.
  let connectorType: ConnectorType | undefined;
  try {
    connectorType = ConnectorManager.getSourceConfig(rawSourceId)?.type;
  } catch {
    return null;
  }
  if (!connectorType) return null;
  const classified = classifyConnectionError(error, connectorType, displaySourceId);
  if (!classified) return null;
  return createSafeToolErrorView(classified.code, classified.message);
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
    let requestStoreError: string | undefined;
    let result: TResult | undefined;
    let error: Error | undefined;

    try {
      result = await handler(args, extra);
      return result;
    } catch (err) {
      success = false;
      error = err as Error;
      requestStoreError = createGenericExecutionErrorView().requestStoreError;
      throw err;
    } finally {
      const metadata = getMetadata(args, result, error);
      trackToolRequest(metadata, startTime, extra, success, requestStoreError);
    }
  };
}
