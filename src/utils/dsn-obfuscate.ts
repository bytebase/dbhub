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
 * Obfuscates the password in a DSN string for logging purposes
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

    // No password to obfuscate
    if (!url.password) {
      return dsn;
    }

    // Reconstruct DSN with obfuscated password
    const obfuscatedPassword = '*'.repeat(Math.min(url.password.length, 8));
    const protocol = dsn.split(':')[0];

    let result;
    if (url.username) {
      result = `${protocol}://${url.username}:${obfuscatedPassword}@${url.hostname}`;
    } else {
      result = `${protocol}://${obfuscatedPassword}@${url.hostname}`;
    }
    if (url.port) {
      result += `:${url.port}`;
    }
    result += url.pathname;

    // Preserve query parameters
    if (url.searchParams.size > 0) {
      const params: string[] = [];
      url.forEachSearchParam((value, key) => {
        params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      });
      result += `?${params.join('&')}`;
    }

    return result;
  } catch {
    // If parsing fails, return original DSN
    return dsn;
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
    'sqlite': 'sqlite'
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
    'sqlite': undefined,
  };
  return ports[type];
}