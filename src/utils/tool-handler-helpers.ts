/**
 * Tool Handler Helpers
 * Shared utilities for MCP tool handlers to reduce boilerplate
 */

import type { Connector, ConnectorType, SQLResultSet } from "../connectors/interface.js";
import { ConnectorManager } from "../connectors/manager.js";
import { allowedKeywords } from "./allowed-keywords.js";
import { requestStore } from "../requests/index.js";
import { getClientIdentifier } from "./client-identifier.js";
import { classifyConnectionError } from "./error-classifier.js";
import { createToolErrorResponse, createToolSuccessResponse } from "./response-formatter.js";
import { normalizeSourceId } from "./normalize-id.js";
import { postgresSyntaxError } from "./postgres-sql.js";

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
 * Shapes a connector's per-statement result sets into the tool response's
 * `statements` field. Shared by execute_sql and custom tools so their output
 * contracts can't silently diverge (e.g. one gaining a field the other doesn't).
 */
export function toStatementsPayload(
  resultSets: SQLResultSet[]
): Array<{ sql?: string; rows: any[]; count: number; truncated?: boolean }> {
  return resultSets.map((set) => ({
    sql: set.sql,
    rows: set.rows,
    count: set.rowCount,
    // Only present when a max_rows cap actually cut off rows, so consumers
    // can tell a capped result from a table with exactly max_rows rows
    // (and complete results don't pay the extra tokens).
    ...(set.truncated ? { truncated: true } : {}),
  }));
}

/**
 * Resolve the tool name a handler was actually registered under, for request
 * tracking. Mirrors resolveBuiltinToolNaming in tool-metadata.ts: single-source
 * deployments keep the bare tool name (no suffix, regardless of the source's
 * own id), while multi-source ones suffix with the *normalized* source id.
 * Do not substitute a plain `sourceId === "default"` check here - that only
 * happens to match in the no-`--id` single-source case, and silently
 * diverges from the registered name for `--id`-configured single sources or
 * multi-source ids containing characters normalizeSourceId rewrites.
 */
export function resolveTrackedToolName(sourceId: string | undefined, baseName: string): string {
  const isSingleSource = ConnectorManager.getAvailableSourceIds().length === 1;
  if (isSingleSource) {
    return baseName;
  }
  return `${baseName}_${normalizeSourceId(getEffectiveSourceId(sourceId))}`;
}

/**
 * For a read-only denial: the parser's error when the SQL was refused because
 * it could not be read, rather than because it writes. PostgreSQL only; other
 * dialects are classified by keyword and have no parser to fail. Without it a
 * typo reads as a blocked write and gives the caller nothing to correct.
 */
export function unparsedSQLReason(sql: string, connectorType: ConnectorType): string | null {
  return connectorType === "postgres" ? postgresSyntaxError(sql) : null;
}

/**
 * Create a readonly violation error message
 * @param toolName Tool name for error message
 * @param sourceId Source ID for error message
 * @param connectorType Database connector type
 * @param statement The tool's SQL, to say so when it was refused as unparseable
 * @returns Formatted error message
 */
export function createReadonlyViolationMessage(
  toolName: string,
  sourceId: string,
  connectorType: ConnectorType,
  statement?: string
): string {
  const prefix = `Tool '${toolName}' cannot execute in readonly mode for source '${sourceId}'.`;
  const unparsed = statement === undefined ? null : unparsedSQLReason(statement, connectorType);
  if (unparsed) {
    return `${prefix} Its statement could not be parsed as PostgreSQL, so it was not run: ${unparsed}`;
  }
  return `${prefix} Only read-only SQL operations are allowed: ${allowedKeywords[connectorType]?.join(", ") || "none"}`;
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
): ReturnType<typeof createToolErrorResponse> | null {
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
  return createToolErrorResponse(classified.message, classified.code, {
    source_id: displaySourceId,
  });
}

/**
 * A failure a tool reports itself — invalid input, a read-only violation, an
 * unsupported database. Thrown from a runToolRequest body, it is returned to
 * the client under `code` as-is, skipping connection-error classification.
 */
export class ToolError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

/**
 * What every tool handler returns: the JSON envelope as text content, flagged
 * `isError` when the call failed.
 */
export type ToolResponse = ReturnType<typeof createToolSuccessResponse> & { isError?: boolean };

/**
 * What runToolRequest needs to know about a tool call besides its body.
 */
export interface ToolRequest {
  /** Source the tool is bound to (undefined => the default source) */
  sourceId: string | undefined;
  /** Name the request is tracked under — see resolveTrackedToolName */
  toolName: string;
  /** SQL, or a description of the request, shown in the request trace */
  sql: string;
  /** MCP extra context, for client identification */
  extra: any;
  /**
   * Shape the response for an error that is neither a ToolError nor a
   * connection failure. Defaults to the raw message under EXECUTION_ERROR.
   * `tracked` overrides the message recorded in the request trace (the raw
   * error message otherwise).
   */
  describeError?: (error: unknown) => { message: string; code: string; tracked?: string };
}

/**
 * The shell every tool handler shares: connect to the source (lazily), run the
 * tool, shape the response, classify connection failures, and record the
 * request — whatever the outcome — in the request trace.
 *
 * The body gets `connect` rather than a connector so it can validate its input
 * before a (possibly lazy) connection is opened. It returns the response data
 * on success and throws on failure: a ToolError for a failure it diagnosed
 * itself, anything else for the error handling described on ToolRequest.
 */
export async function runToolRequest<T>(
  request: ToolRequest,
  body: (connect: () => Promise<Connector>, effectiveSourceId: string) => Promise<T>
): Promise<ToolResponse> {
  const startTime = Date.now();
  const effectiveSourceId = getEffectiveSourceId(request.sourceId);
  let success = true;
  let errorMessage: string | undefined;

  try {
    const data = await body(async () => {
      // Ensure the source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(request.sourceId);
      return ConnectorManager.getCurrentConnector(request.sourceId);
    }, effectiveSourceId);
    return createToolSuccessResponse(data);
  } catch (error) {
    success = false;
    errorMessage = (error as Error).message;

    if (error instanceof ToolError) {
      return createToolErrorResponse(error.message, error.code);
    }

    // A connection/access failure is not a problem with the request itself —
    // classify and return it cleanly, ahead of any tool-specific shaping.
    const classified = tryClassifyConnectionError(error, request.sourceId, effectiveSourceId);
    if (classified) return classified;

    const described = request.describeError?.(error) ?? {
      message: errorMessage,
      code: "EXECUTION_ERROR",
    };
    errorMessage = described.tracked ?? errorMessage;
    return createToolErrorResponse(described.message, described.code);
  } finally {
    trackToolRequest(
      { sourceId: effectiveSourceId, toolName: request.toolName, sql: request.sql },
      startTime,
      request.extra,
      success,
      errorMessage
    );
  }
}
