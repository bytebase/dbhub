/**
 * Thrown when a CA certificate file specified via `sslrootcert` cannot be read
 * (e.g. the file does not exist or is not accessible).
 *
 * Using a dedicated error class allows the outer DSN-parsing catch block to
 * re-throw it without wrapping, so callers receive a clear, actionable message
 * about the missing certificate rather than a generic "Failed to parse DSN" error.
 */
export class FailedToReadCertificate extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FailedToReadCertificate";
  }
}
