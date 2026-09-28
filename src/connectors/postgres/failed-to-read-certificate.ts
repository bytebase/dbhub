/**
 * Thrown when an SSL file referenced by a DSN parameter (`sslrootcert`,
 * `sslcert`, `sslkey`) cannot be read or used, or when those parameters are
 * combined inconsistently (e.g. `sslcert` without `sslkey`, or a client
 * certificate on a connection with TLS disabled).
 */
export class FailedToReadCertificate extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FailedToReadCertificate";
  }
}
