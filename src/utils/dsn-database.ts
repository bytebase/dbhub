import { obfuscateDSNPassword } from "./dsn-obfuscate.js";

/**
 * Raised when a DSN omits the database component for a connector that requires
 * one. Distinct from a generic parse failure so DSN parsers can rethrow it
 * unchanged instead of burying it under "Failed to parse ... DSN:".
 */
export class MissingDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingDatabaseError";
  }
}

/**
 * Reject a DSN that names no database.
 *
 * MySQL/MariaDB can connect without a default database, but DBHub does not
 * support it: `USE other_db` cannot switch databases (it is not a read-only
 * allowed keyword, and each query checks a connection out of the pool and
 * releases it, so the change would not persist), unqualified SQL fails with
 * "No database selected", and schema discovery would fan out across every
 * database on the server. Multi-database setups belong in a TOML config with
 * one source per database.
 *
 * @param database  Database component extracted from the DSN (may be empty)
 * @param dsn       Original DSN, used to build an obfuscated error message
 * @param label     Human-readable connector name, e.g. "MySQL"
 */
export function requireDatabaseInDSN(database: string, dsn: string, label: string): void {
  if (database) {
    return;
  }

  throw new MissingDatabaseError(
    `${label} DSN must name a database.\n` +
      `Provided: ${obfuscateDSNPassword(dsn)}\n` +
      `Add the database to the DSN, e.g. ...:3306/mydb\n` +
      `To work with several databases, define one [[sources]] entry per ` +
      `database in a TOML config file: https://dbhub.ai/config/toml`
  );
}
