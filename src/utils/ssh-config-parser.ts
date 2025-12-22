import { readFileSync, existsSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import SSHConfig from 'ssh-config';
import type { SSHTunnelConfig } from '../types/ssh.js';

/**
 * Default SSH key paths to check if no IdentityFile is specified
 */
const DEFAULT_SSH_KEYS = [
  '~/.ssh/id_rsa',
  '~/.ssh/id_ed25519',
  '~/.ssh/id_ecdsa',
  '~/.ssh/id_dsa'
];

/**
 * Expand tilde (~) in file paths to home directory
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return join(homedir(), filePath.substring(2));
  }
  return filePath;
}

/**
 * Resolve a path, following symlinks if necessary.
 * This is particularly important on Windows where .ssh directory
 * may be a directory junction or symbolic link.
 * @param filePath The path to resolve
 * @returns The resolved real path, or the original path if resolution fails
 */
export function resolveSymlink(filePath: string): string {
  try {
    // First expand tilde
    const expandedPath = expandTilde(filePath);

    // Try to resolve the real path (follows symlinks)
    return realpathSync(expandedPath);
  } catch {
    // If realpathSync fails (e.g., file doesn't exist yet),
    // fall back to just expanding tilde
    return expandTilde(filePath);
  }
}

/**
 * Check if a file exists, properly handling symlinks on Windows.
 * Uses realpathSync to resolve symlinks before checking existence.
 */
function fileExists(filePath: string): boolean {
  try {
    const expandedPath = expandTilde(filePath);

    // First try to resolve symlinks and check if target exists
    try {
      const realPath = realpathSync(expandedPath);
      const stat = statSync(realPath);
      return stat.isFile();
    } catch {
      // If realpathSync fails, fall back to basic existsSync
      // This handles cases where the file simply doesn't exist
      return existsSync(expandedPath);
    }
  } catch {
    return false;
  }
}

/**
 * Find the first existing SSH key from default locations
 */
function findDefaultSSHKey(): string | undefined {
  for (const keyPath of DEFAULT_SSH_KEYS) {
    // Resolve symlinks (important for Windows where .ssh may be a junction)
    const resolvedPath = resolveSymlink(keyPath);
    if (fileExists(resolvedPath)) {
      return resolvedPath;
    }
  }
  return undefined;
}

/**
 * Parse SSH config file and extract configuration for a specific host
 * @param hostAlias The host alias to look up in the SSH config
 * @param configPath Path to SSH config file
 * @returns SSH tunnel configuration or null if not found
 */
export function parseSSHConfig(
  hostAlias: string,
  configPath: string
): SSHTunnelConfig | null {
  // Resolve symlinks in the config path (important for Windows where .ssh may be a junction)
  const sshConfigPath = resolveSymlink(configPath);

  // Check if SSH config file exists
  if (!existsSync(sshConfigPath)) {
    return null;
  }

  try {
    // Read and parse SSH config file
    const configContent = readFileSync(sshConfigPath, 'utf8');
    const config = SSHConfig.parse(configContent);

    // Find configuration for the specified host
    const hostConfig = config.compute(hostAlias);
    
    // Check if we have a valid config (not just Include directives)
    if (!hostConfig || !hostConfig.HostName && !hostConfig.User) {
      return null;
    }

    // Extract SSH configuration parameters
    const sshConfig: Partial<SSHTunnelConfig> = {};

    // Host (required)
    if (hostConfig.HostName) {
      sshConfig.host = hostConfig.HostName;
    } else {
      // If no HostName specified, use the host alias itself
      sshConfig.host = hostAlias;
    }

    // Port (optional, default will be 22)
    if (hostConfig.Port) {
      sshConfig.port = parseInt(hostConfig.Port, 10);
    }

    // User (required)
    if (hostConfig.User) {
      sshConfig.username = hostConfig.User;
    }

    // IdentityFile (private key)
    if (hostConfig.IdentityFile) {
      // SSH config can have multiple IdentityFile entries, take the first one
      const identityFile = Array.isArray(hostConfig.IdentityFile)
        ? hostConfig.IdentityFile[0]
        : hostConfig.IdentityFile;

      // Resolve symlinks (important for Windows where .ssh may be a junction)
      const resolvedPath = resolveSymlink(identityFile);
      if (fileExists(resolvedPath)) {
        sshConfig.privateKey = resolvedPath;
      }
    }

    // If no IdentityFile specified or found, try default SSH keys
    if (!sshConfig.privateKey) {
      const defaultKey = findDefaultSSHKey();
      if (defaultKey) {
        sshConfig.privateKey = defaultKey;
      }
    }

    // ProxyJump support could be added in the future if needed
    // Currently, we'll log a warning if ProxyJump is detected
    if (hostConfig.ProxyJump || hostConfig.ProxyCommand) {
      console.error('Warning: ProxyJump/ProxyCommand in SSH config is not yet supported by DBHub');
    }

    // Validate that we have minimum required fields
    if (!sshConfig.host || !sshConfig.username) {
      return null;
    }

    return sshConfig as SSHTunnelConfig;
  } catch (error) {
    console.error(`Error parsing SSH config: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Check if a string looks like an SSH host alias (not an IP or domain)
 * This is a heuristic to determine if we should look up the host in SSH config
 */
export function looksLikeSSHAlias(host: string): boolean {
  // If it contains dots, it's likely a domain or IP
  if (host.includes('.')) {
    return false;
  }
  
  // If it's all numbers (with possible colons for IPv6), it's likely an IP
  if (/^[\d:]+$/.test(host)) {
    return false;
  }
  
  // Check for IPv6 addresses with hex characters
  if (/^[0-9a-fA-F:]+$/.test(host) && host.includes(':')) {
    return false;
  }
  
  // Otherwise, treat it as a potential SSH alias
  return true;
}