/**
 * Custom error class for API-related errors with HTTP status codes
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
