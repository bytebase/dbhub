/**
 * Thrown when a CA certificate file specified via `sslrootcert` cannot be read
 * (e.g. the file does not exist or is not accessible).
 */
export class FailedToReadCertificate extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FailedToReadCertificate";
  }
}
