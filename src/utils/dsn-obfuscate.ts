import type { SSHTunnelConfig } from '../types/ssh.js';
import type { ConnectorType } from '../connectors/interface.js';
import { SafeURL } from './safe-url.js';

/**
 * Parsed connection information from a DSN string
 * Used to populate SourceConfig fields when DSN is provided
 */
export interface ParsedConnectionInfo {
  type?: ConnectorType;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

/**
 * Parse connection information from a DSN string
 * Extracts host, port, database, user, and type without exposing password
 *
 * @param dsn - Database connection string
 * @returns Parsed connection info or null if parsing fails
 */
export function parseConnectionInfoFromDSN(dsn: string): ParsedConnectionInfo | null {
  if (!dsn) {
    return null;
  }

  try {
    const type = getDatabaseTypeFromDSN(dsn);
    if (typeof type === 'undefined') {
      return null;
    }

    // Handle SQLite specially - it only has a database path
    if (type === 'sqlite') {
      // SQLite DSN format: sqlite:///path
      const prefix = 'sqlite:///';
      if (dsn.length > prefix.length) {
        const rawPath = dsn.substring(prefix.length);
        // Add leading '/' for Unix absolute paths only
        // Don't add '/' for:
        // - Memory database: starts with ':'
        // - Relative paths: starts with '.' or '~'
        // - Windows absolute: second char is ':' (e.g., C:/path)
        const firstChar = rawPath[0];
        const isWindowsDrive = rawPath.length > 1 && rawPath[1] === ':';
        const isSpecialPath = firstChar === ':' || firstChar === '.' || firstChar === '~' || isWindowsDrive;
        return {
          type,
          database: isSpecialPath ? rawPath : '/' + rawPath,
        };
      }
      return { type };
    }

    // Parse other database DSNs using SafeURL
    const url = new SafeURL(dsn);

    const info: ParsedConnectionInfo = { type };

    if (url.hostname) {
      info.host = url.hostname;
    }

    if (url.port) {
      info.port = parseInt(url.port, 10);
    }

    if (url.pathname && url.pathname.length > 1) {
      // Remove leading '/' from pathname
      info.database = url.pathname.substring(1);
    }

    if (url.username) {
      info.user = url.username;
    }

    return info;
  } catch {
    // If parsing fails, return null
    return null;
  }
}

/**
 * Placeholder returned in place of a DSN that could not be parsed.
 * Unparseable input (e.g. a scheme-less "user:pass@host/db") may still carry a
 * password, so the original string is never echoed back.
 */
export const REDACTED_DSN = '<redacted DSN>';

/** DSN query parameters whose value is a secret and must not be logged. */
const SECRET_QUERY_PARAM = /password/i;

/** decodeURIComponent that hands back the input when it is not valid encoding */
function decodeLoosely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Mask the value of every secret-bearing parameter in a raw DSN query string,
 * leaving everything else byte-for-byte as written.
 *
 * Each pair is split at its first '=', so a secret whose value contains an
 * unescaped '=' (e.g. `wallet_password=secret==`) is still recognised and
 * masked. Keys are matched both raw and percent-decoded.
 */
function maskSecretQueryParams(rawQuery: string): { query: string; hasSecretParam: boolean } {
  let hasSecretParam = false;
  const pairs = rawQuery.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      return pair;
    }
    const key = pair.substring(0, eq);
    const value = pair.substring(eq + 1);
    if (!value || !(SECRET_QUERY_PARAM.test(key) || SECRET_QUERY_PARAM.test(decodeLoosely(key)))) {
      return pair;
    }
    hasSecretParam = true;
    return `${key}=${'*'.repeat(Math.min(decodeLoosely(value).length, 8))}`;
  });
  return { query: pairs.join('&'), hasSecretParam };
}

/**
 * Obfuscates the password in a DSN string for logging purposes.
 * Fails closed: if the DSN cannot be parsed, returns REDACTED_DSN rather than
 * the original string.
 * @param dsn The original DSN string
 * @returns DSN string with password replaced by asterisks
 */
export function obfuscateDSNPassword(dsn: string): string {
  if (!dsn) {
    return dsn;
  }

  try {
    const type = getDatabaseTypeFromDSN(dsn);

    // SQLite has no password to obfuscate
    if (type === 'sqlite') {
      return dsn;
    }

    // Parse DSN using SafeURL
    const url = new SafeURL(dsn);

    // A DSN whose authority lacks an '@' (e.g. "postgres://user:secret/db")
    // parses with "user" as the host and "secret" as the port. A real port is
    // always numeric, so treat anything else as unparseable rather than
    // echoing what is likely a credential.
    if (url.port && !/^\d+$/.test(url.port)) {
      return REDACTED_DSN;
    }

    // Query parameters can carry secrets too (e.g. Oracle wallet_password).
    // They are masked from the raw query string rather than SafeURL's parsed
    // params: a pair SafeURL cannot parse is dropped from the params, and a
    // dropped secret would otherwise be echoed verbatim.
    const queryStart = dsn.indexOf('?');
    const rawQuery = queryStart === -1 ? '' : dsn.substring(queryStart + 1);
    const { query, hasSecretParam } = maskSecretQueryParams(rawQuery);

    // No password to obfuscate
    if (!url.password && !hasSecretParam) {
      return dsn;
    }

    // Reconstruct DSN with obfuscated password
    const protocol = dsn.split(':')[0];

    // SafeURL strips the brackets from an IPv6 literal so drivers get the bare
    // address; a DSN needs them back, or the address's colons read as a port.
    const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;

    let userinfo = url.username;
    if (url.password) {
      const obfuscatedPassword = '*'.repeat(Math.min(url.password.length, 8));
      userinfo = url.username ? `${url.username}:${obfuscatedPassword}` : obfuscatedPassword;
    }
    let result = userinfo ? `${protocol}://${userinfo}@${host}` : `${protocol}://${host}`;
    if (url.port) {
      result += `:${url.port}`;
    }
    result += url.pathname;

    // Preserve query parameters as written, with secret values masked
    if (rawQuery) {
      result += `?${query}`;
    }

    return result;
  } catch {
    // Fail closed: an unparseable DSN may still contain a password
    return REDACTED_DSN;
  }
}

/**
 * Obfuscates sensitive information in SSH configuration for logging
 * @param config The SSH tunnel configuration
 * @returns SSH config with sensitive data replaced by asterisks
 */
export function obfuscateSSHConfig(config: SSHTunnelConfig): Partial<SSHTunnelConfig> {
  const obfuscated: Partial<SSHTunnelConfig> = {
    host: config.host,
    port: config.port,
    username: config.username,
  };
  
  if (config.password) {
    obfuscated.password = '*'.repeat(8);
  }
  
  if (config.privateKey) {
    obfuscated.privateKey = config.privateKey; // Keep path as-is
  }
  
  if (config.passphrase) {
    obfuscated.passphrase = '*'.repeat(8);
  }
  
  return obfuscated;
}

/**
 * Extracts the database type from a DSN string
 * @param dsn The DSN string to analyze
 * @returns The database type or undefined if cannot be determined
 */
export function getDatabaseTypeFromDSN(dsn: string): ConnectorType | undefined {
  if (!dsn) {
    return undefined;
  }

  const protocol = dsn.split(':')[0];
  return protocolToConnectorType(protocol);
}

/**
 * Maps a protocol string to a ConnectorType
 */
function protocolToConnectorType(protocol: string): ConnectorType | undefined {
  const mapping: Record<string, ConnectorType> = {
    'postgres': 'postgres',
    'postgresql': 'postgres',
    'mysql': 'mysql',
    'mariadb': 'mariadb',
    'sqlserver': 'sqlserver',
    'sqlite': 'sqlite',
    'oracle': 'oracle'
  };
  return mapping[protocol];
}

/**
 * Get the default port for a database type
 * @param type The database connector type
 * @returns The default port or undefined for SQLite
 */
export function getDefaultPortForType(type: ConnectorType): number | undefined {
  const ports: Record<ConnectorType, number | undefined> = {
    'postgres': 5432,
    'mysql': 3306,
    'mariadb': 3306,
    'sqlserver': 1433,
    'oracle': 1521,
    'sqlite': undefined,
  };
  return ports[type];
}