/**
 * Response formatter utility for consistent tool responses
 */

const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Custom JSON replacer function to handle BigInt serialization.
 * Values within Number.MAX_SAFE_INTEGER are converted to Number.
 * Values exceeding safe range are converted to string to preserve precision.
 */
export function bigIntReplacer(_key: string, value: any): any {
  if (typeof value === 'bigint') {
    if (value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT) {
      return Number(value);
    }
    return value.toString();
  }
  return value;
}

/**
 * Create a success response with the given data
 */
export function formatSuccessResponse<T>(
  data: T,
  meta: Record<string, any> = {}
): {
  success: true;
  data: T;
  meta?: Record<string, any>;
} {
  return {
    success: true,
    data,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

/**
 * Create an error response with the given message and code
 */
export function formatErrorResponse(
  error: string,
  code: string = "ERROR",
  details?: any
): {
  success: false;
  error: string;
  code: string;
  details?: any;
} {
  return {
    success: false,
    error,
    code,
    ...(details ? { details } : {}),
  };
}

/**
 * Create a tool error response object
 */
export function createToolErrorResponse(error: string, code: string = "ERROR", details?: any) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(formatErrorResponse(error, code, details), bigIntReplacer, 2),
        mimeType: "application/json",
      },
    ],
    isError: true,
  };
}

/**
 * Create a tool success response object
 */
export function createToolSuccessResponse<T>(data: T, meta: Record<string, any> = {}) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(formatSuccessResponse(data, meta), bigIntReplacer, 2),
        mimeType: "application/json",
      },
    ],
  };
}
