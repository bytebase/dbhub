import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { splitSQLStatements, stripCommentsAndStrings } from "../utils/sql-parser.js";
import { getFirstKeyword } from "../utils/allowed-keywords.js";
import type { ConnectorType } from "../connectors/interface.js";
import {
  getEffectiveSourceId,
  resolveTrackedToolName,
  trackToolRequest,
  tryClassifyConnectionError,
} from "../utils/tool-handler-helpers.js";

// Schema for explain_sql tool. See execute-sql.ts for why the raw shape is
// exported separately from the wrapped z.object().
export const explainSqlSchema = {
  sql: z.string().describe("Single SQL statement to explain (no trailing semicolon-separated statements)"),
};

export const explainSqlInputSchema = z.object(explainSqlSchema);

/**
 * Build the dialect-appropriate EXPLAIN statement for a given connector type.
 * Deliberately never emits ANALYZE (or any variant that executes the target
 * statement) - explain_sql is meant to always be side-effect free, regardless
 * of the source's readonly/write configuration.
 */
function buildExplainStatement(connectorType: ConnectorType, sql: string): string {
  // Bare EXPLAIN on SQLite returns raw VDBE bytecode, not a query plan.
  // EXPLAIN QUERY PLAN is the human-readable form.
  if (connectorType === "sqlite") {
    return `EXPLAIN QUERY PLAN ${sql}`;
  }
  return `EXPLAIN ${sql}`;
}

/**
 * Reject input that could turn the tool's own EXPLAIN prefix into something
 * that actually executes the statement (e.g. a leading ANALYZE combining with
 * our prefix to form "EXPLAIN ANALYZE ..."), or that smuggles multiple
 * statements past the single EXPLAIN we emit.
 */
function validateExplainInput(sql: string, connectorType: ConnectorType): string | null {
  const statements = splitSQLStatements(sql, connectorType);
  if (statements.length !== 1) {
    return "explain_sql only supports a single SQL statement";
  }

  const firstWord = getFirstKeyword(statements[0], connectorType);
  if (firstWord === "explain") {
    return "explain_sql input must not itself start with EXPLAIN";
  }
  if (firstWord === "analyze") {
    return "explain_sql does not support ANALYZE (it must never execute the statement)";
  }

  // PostgreSQL's EXPLAIN accepts a parenthesized option list immediately
  // after EXPLAIN (e.g. EXPLAIN (ANALYZE, VERBOSE) SELECT ...). Input
  // starting with such a "(...)" block combines with our EXPLAIN prefix into
  // a form that actually executes the statement, bypassing the bare-ANALYZE
  // check above (whose \S+ matching never isolates "analyze" as its own
  // token when it's glued to parens/commas).
  const cleaned = stripCommentsAndStrings(statements[0], connectorType).trim();
  const leadingOptions = cleaned.match(/^\(([\s\S]*?)\)/)?.[1];
  if (leadingOptions && /\banalyze\b/i.test(leadingOptions)) {
    return "explain_sql does not support ANALYZE (it must never execute the statement)";
  }

  return null;
}

/**
 * Create an explain_sql tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to. Registration
 * (see tools/index.ts) always passes a concrete id ("default" or an actual
 * source id) - undefined is only meaningful for direct/test invocation,
 * where it's treated the same as "default" via getEffectiveSourceId.
 * @returns A handler function bound to the specified source
 */
export function createExplainSqlToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { sql } = args as { sql: string };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;
    let result: any;

    try {
      // Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(sourceId);

      // Get connector for the specified source (or default)
      const connector = ConnectorManager.getCurrentConnector(sourceId);

      const validationError = validateExplainInput(sql, connector.id);
      if (validationError) {
        success = false;
        errorMessage = validationError;
        return createToolErrorResponse(errorMessage, "INVALID_INPUT");
      }

      // Always readonly: plain EXPLAIN never executes the target statement
      // on any supported engine, so this is safe regardless of the source's
      // own execute_sql readonly/max_rows configuration.
      const explainStatement = buildExplainStatement(connector.id, sql);
      result = await connector.executeSQL(explainStatement, { readonly: true });

      const responseData = {
        rows: result.rows,
        count: result.rowCount,
        source_id: effectiveSourceId,
        ...(result.messages && result.messages.length > 0 ? { messages: result.messages } : {}),
      };

      return createToolSuccessResponse(responseData);
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
          toolName: resolveTrackedToolName(sourceId, "explain_sql"),
          sql,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
