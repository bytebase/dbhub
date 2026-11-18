/**
 * `sslmode` handling shared by the MySQL and MariaDB DSN parsers. The mode
 * names and their meaning are common to both; how each mode maps onto the
 * driver's `ssl` option is not (mysql2 verifies the hostname only when asked,
 * the mariadb driver unless told otherwise), so that mapping stays with each
 * connector.
 */

import { rawQueryParamValues } from "../utils/safe-url.js";

/**
 * - disable: no TLS
 * - require: TLS, server certificate not verified
 * - verify-ca: TLS, certificate chain verified against the trust store
 * - verify-full: verify-ca plus the certificate must match the host name
 */
export const MYSQL_FAMILY_SSL_MODES = ["disable", "require", "verify-ca", "verify-full"] as const;

export type MySQLFamilySslMode = (typeof MYSQL_FAMILY_SSL_MODES)[number];

/**
 * Validate a DSN `sslmode` value.
 *
 * An unrecognised mode (MySQL's own PREFERRED / VERIFY_IDENTITY spellings, or
 * a typo) used to fall through to certificate verification without a host name
 * check — neither what `prefer` asks for nor what `verify-full` promises.
 * Reject it instead of guessing.
 */
export function parseMySQLFamilySslMode(value: string): MySQLFamilySslMode {
  if (!(MYSQL_FAMILY_SSL_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `Unsupported sslmode '${value}'. Valid values: ${MYSQL_FAMILY_SSL_MODES.join(", ")}`
    );
  }
  return value as MySQLFamilySslMode;
}

/**
 * Read and validate the `sslmode` of a MySQL / MariaDB DSN. Returns undefined
 * when the DSN has no `sslmode` parameter at all, which leaves TLS off.
 *
 * The raw query string is inspected rather than SafeURL's parsed parameters
 * (see rawQueryParamValues): `?sslmode=` and a bare `?sslmode` would
 * otherwise look exactly like an absent one and connect unencrypted instead
 * of being rejected. Every occurrence must be valid; with several, the last
 * one applies, as it did through SafeURL.
 */
export function readMySQLFamilySslMode(dsn: string): MySQLFamilySslMode | undefined {
  return rawQueryParamValues(dsn, "sslmode").map(parseMySQLFamilySslMode).at(-1);
}
