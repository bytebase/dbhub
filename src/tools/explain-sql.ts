import { z } from "zod";
import {
  LEADING_SQL_NOISE,
  splitSQLStatementVariants,
  stripCommentsAndStringsVariants,
} from "../utils/sql-parser.js";
import {
  explainAnalyzeKeyword,
  nonExecutingExplainOptions,
  readExplainOptionList,
} from "../utils/allowed-keywords.js";
import type { ConnectorType } from "../connectors/interface.js";
import { BUILTIN_TOOL_EXPLAIN_SQL } from "./builtin-tools.js";
import { resolveTrackedToolName, runToolRequest, ToolError } from "../utils/tool-handler-helpers.js";

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
  // ClickHouse's bare plan only names the steps. `indexes = 1` adds, for each
  // table read, the parts and granules its keys and skipping indexes leave to
  // scan, which is the cost that matters there. It is still analysis only.
  // Added for a query; input that opens with an EXPLAIN kind or settings of
  // its own (`PIPELINE ...`, `ESTIMATE ...`, `actions = 1 ...`) is left as is.
  if (
    connectorType === "clickhouse" &&
    /^(?:select|with|\()/i.test(sql.replace(LEADING_SQL_NOISE, ""))
  ) {
    return `EXPLAIN indexes = 1 ${sql}`;
  }
  return `EXPLAIN ${sql}`;
}

const ANALYZE_NOT_SUPPORTED =
  "explain_sql does not support ANALYZE (it must never execute the statement)";

/**
 * Reject input that could turn the tool's own EXPLAIN prefix into something
 * that actually executes the statement (e.g. a leading ANALYZE combining with
 * our prefix to form "EXPLAIN ANALYZE ..."), or that smuggles multiple
 * statements past the single EXPLAIN we emit.
 */
function validateExplainInput(sql: string, connectorType: ConnectorType): string | null {
  // Every reading of the dialect's string syntax must see one statement, since
  // the server's setting (e.g. MySQL NO_BACKSLASH_ESCAPES) is not known here.
  const variants = splitSQLStatementVariants(sql, connectorType);
  if (variants.some((statements) => statements.length !== 1)) {
    return "explain_sql only supports a single SQL statement";
  }

  for (const [statement] of variants) {
    for (const cleaned of stripCommentsAndStringsVariants(statement, connectorType)) {
      const error = validateCleanedExplainInput(cleaned.trim());
      if (error) {
        return error;
      }
    }
  }
  return null;
}

function validateCleanedExplainInput(cleaned: string): string | null {
  if (/^explain\b/i.test(cleaned)) {
    return "explain_sql input must not itself start with EXPLAIN";
  }
  if (explainAnalyzeKeyword.test(cleaned)) {
    return ANALYZE_NOT_SUPPORTED;
  }

  // PostgreSQL's EXPLAIN accepts a parenthesized option list immediately
  // after EXPLAIN (e.g. EXPLAIN (ANALYZE, VERBOSE) SELECT ...). Input
  // starting with such a "(...)" block combines with our EXPLAIN prefix into
  // a form that actually executes the statement. Matching ANALYZE alone is
  // not enough: PostgreSQL also honours a quoted option name ("analyze"),
  // which the stripping above has blanked out. So a leading option list is
  // only accepted when every option in it is one known not to execute.
  const optionList = readExplainOptionList(cleaned);
  if (optionList?.options.some(({ name }) => explainAnalyzeKeyword.test(name))) {
    return ANALYZE_NOT_SUPPORTED;
  }
  if (optionList?.options.some(({ name }) => !nonExecutingExplainOptions.has(name))) {
    return (
      "explain_sql only accepts these EXPLAIN options, written unquoted: " +
      [...nonExecutingExplainOptions].join(", ")
    );
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

    return runToolRequest(
      {
        sourceId,
        toolName: resolveTrackedToolName(sourceId, BUILTIN_TOOL_EXPLAIN_SQL),
        sql,
        extra,
      },
      async (connect, effectiveSourceId) => {
        const connector = await connect();

        const validationError = validateExplainInput(sql, connector.id);
        if (validationError) {
          throw new ToolError(validationError, "INVALID_INPUT");
        }

        // Always readonly: plain EXPLAIN never executes the target statement
        // on any supported engine, so this is safe regardless of the source's
        // own execute_sql readonly/max_rows configuration.
        const explainStatement = buildExplainStatement(connector.id, sql);
        const result = await connector.executeSQL(explainStatement, { readonly: true });

        // explain_sql only ever accepts a single statement (validateExplainInput
        // above rejects anything else), so exactly one result set comes back.
        return {
          rows: result.resultSets[0].rows,
          count: result.resultSets[0].rowCount,
          source_id: effectiveSourceId,
          ...(result.messages && result.messages.length > 0 ? { messages: result.messages } : {}),
        };
      }
    );
  };
}
