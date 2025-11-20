import type { SSHTunnelConfig } from '../types/ssh.js';
import type { ConnectorType } from '../connectors/interface.js';

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
    // Handle different DSN formats
    const protocolMatch = dsn.match(/^([^:]+):/);
    if (!protocolMatch) {
      return dsn; // Not a recognizable DSN format
    }

    const protocol = protocolMatch[1];

    // For SQLite file paths, don't obfuscate
    if (protocol === 'sqlite') {
      return dsn;
    }

    // For other databases, look for password pattern: ://user:password@host
    // We need to be careful with @ in passwords, so we'll find the last @ that separates password from host
    const protocolPart = dsn.split('://')[1];
    if (!protocolPart) {
      return dsn;
    }
    
    // Find the last @ to separate credentials from host
    const lastAtIndex = protocolPart.lastIndexOf('@');
    if (lastAtIndex === -1) {
      return dsn; // No @ found, no password to obfuscate
    }
    
    const credentialsPart = protocolPart.substring(0, lastAtIndex);
    const hostPart = protocolPart.substring(lastAtIndex + 1);
    
    // Check if there's a colon in credentials (user:password format)
    const colonIndex = credentialsPart.indexOf(':');
    if (colonIndex === -1) {
      return dsn; // No colon found, no password to obfuscate
    }
    
    const username = credentialsPart.substring(0, colonIndex);
    const password = credentialsPart.substring(colonIndex + 1);
    const obfuscatedPassword = '*'.repeat(Math.min(password.length, 8));
    
    return `${protocol}://${username}:${obfuscatedPassword}@${hostPart}`;
  } catch (error) {
    // If any error occurs during obfuscation, return the original DSN
    // This ensures we don't break functionality due to obfuscation issues
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
  const protocolToType: Record<string, ConnectorType> = {
    'postgres': 'postgres',
    'postgresql': 'postgres',
    'mysql': 'mysql',
    'mariadb': 'mariadb',
    'sqlserver': 'sqlserver',
    'sqlite': 'sqlite'
  };

  return protocolToType[protocol];
}