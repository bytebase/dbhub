import { createToolErrorResponse } from "./response-formatter.js";

export type SafeExecutionErrorCode =
  | "MYSQL_READONLY_GUARDRAIL"
  | "MYSQL_MAX_ROWS_GUARDRAIL"
  | "MYSQL_SAFETY_CHECK_FAILED"
  | "QUERY_TIMEOUT";

export type MySQLReadonlyGuardrailCategory =
  | "dangerous_function"
  | "unsupported_sql_mode";

export type MySQLMaxRowsGuardrailCategory =
  | "unsupported_limit_shape"
  | "invalid_limit_parameter"
  | "ambiguous_executable_comment";

export type MySQLSafetyCheckCategory =
  | "flavor_probe_failed"
  | "sql_mode_unavailable"
  | "statement_plan_unsupported"
  | "statement_plan_invariant_failed"
  | "connection_id_invalid"
  | "transaction_cleanup_failed";

export type QueryTimeoutCategory = "deadline_exceeded";

export interface SafeExecutionErrorCategoryByCode {
  MYSQL_READONLY_GUARDRAIL: MySQLReadonlyGuardrailCategory;
  MYSQL_MAX_ROWS_GUARDRAIL: MySQLMaxRowsGuardrailCategory;
  MYSQL_SAFETY_CHECK_FAILED: MySQLSafetyCheckCategory;
  QUERY_TIMEOUT: QueryTimeoutCategory;
}

export type SafeExecutionErrorCategory =
  SafeExecutionErrorCategoryByCode[SafeExecutionErrorCode];

export const SAFE_EXECUTION_MESSAGES: Readonly<Record<SafeExecutionErrorCode, string>> =
  Object.freeze({
  MYSQL_READONLY_GUARDRAIL: "MySQL read-only guardrail rejected the query.",
  MYSQL_MAX_ROWS_GUARDRAIL: "MySQL max_rows guardrail could not safely limit the query.",
  MYSQL_SAFETY_CHECK_FAILED: "MySQL safety precondition failed.",
  QUERY_TIMEOUT:
    "MySQL read-only query exceeded query_timeout; the target connection was isolated.",
  });

export const GENERIC_EXECUTION_ERROR_MESSAGE = "Database query execution failed.";
export const PARAMETER_VALIDATION_ERROR_MESSAGE = "Parameter validation failed.";
export const READONLY_VIOLATION_MESSAGE =
  "The tool cannot execute this statement in readonly mode. Only read-only SQL operations are allowed.";

export class SafeExecutionError<
  Code extends SafeExecutionErrorCode = SafeExecutionErrorCode
> extends Error {
  readonly kind = "safe_execution_error" as const;
  readonly code: Code;
  readonly safeMessage: string;
  readonly category: SafeExecutionErrorCategoryByCode[Code];
  readonly sourceId?: string;
  readonly correlationId?: string;
  readonly cause?: unknown;

  constructor(
    code: Code,
    category: SafeExecutionErrorCategoryByCode[Code],
    options: {
      sourceId?: string;
      correlationId?: string;
      cause?: unknown;
    } = {}
  ) {
    const safeMessage = SAFE_EXECUTION_MESSAGES[code];
    super(safeMessage);
    this.name = "SafeExecutionError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.category = category;
    this.sourceId = options.sourceId;
    this.correlationId = options.correlationId;
    this.cause = options.cause;
    Object.freeze(this);
  }
}

export interface SafeToolErrorView {
  code: string;
  safeMessage: string;
  response: ReturnType<typeof createToolErrorResponse>;
  requestStoreError: string;
}

export function createSafeToolErrorView(code: string, safeMessage: string): SafeToolErrorView {
  return {
    code,
    safeMessage,
    response: createToolErrorResponse(safeMessage, code),
    requestStoreError: `${code}: ${safeMessage}`,
  };
}

export function tryCreateSafeExecutionErrorView(error: unknown): SafeToolErrorView | null {
  if (
    !error ||
    typeof error !== "object" ||
    (error as { kind?: unknown }).kind !== "safe_execution_error"
  ) {
    return null;
  }
  const safeError = error as SafeExecutionError;
  if (
    !Object.prototype.hasOwnProperty.call(SAFE_EXECUTION_MESSAGES, safeError.code) ||
    safeError.safeMessage !== SAFE_EXECUTION_MESSAGES[safeError.code]
  ) {
    return null;
  }
  return createSafeToolErrorView(safeError.code, safeError.safeMessage);
}

export function createGenericExecutionErrorView(): SafeToolErrorView {
  return createSafeToolErrorView("EXECUTION_ERROR", GENERIC_EXECUTION_ERROR_MESSAGE);
}
