<<<<<<< HEAD
<<<<<<< HEAD
import { readFileSync, realpathSync, statSync } from 'fs';
=======
import { readFileSync, existsSync, realpathSync, statSync } from 'fs';
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
import { readFileSync, realpathSync, statSync } from 'fs';
>>>>>>> 3a1c62d (chore: address comment)
import { homedir } from 'os';
import { join } from 'path';
import SSHConfig from 'ssh-config';
import type { SSHTunnelConfig, JumpHost } from '../types/ssh.js';

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
<<<<<<< HEAD
<<<<<<< HEAD
 * @param filePath The path to resolve (may contain ~)
 * @returns The resolved real path, or the expanded path if resolution fails
=======
 * @param filePath The path to resolve
 * @returns The resolved real path, or the original path if resolution fails
=======
 * @param filePath The path to resolve (may contain ~)
 * @returns The resolved real path, or the expanded path if resolution fails
>>>>>>> 3a1c62d (chore: address comment)
 */
export function resolveSymlink(filePath: string): string {
  const expandedPath = expandTilde(filePath);
  try {
    return realpathSync(expandedPath);
  } catch {
    // If realpathSync fails (e.g., file doesn't exist),
    // fall back to the expanded path
    return expandedPath;
  }
}

/**
<<<<<<< HEAD
 * Check if a file exists, properly handling symlinks on Windows.
 * Uses realpathSync to resolve symlinks before checking existence.
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
 */
export function resolveSymlink(filePath: string): string {
  const expandedPath = expandTilde(filePath);
  try {
<<<<<<< HEAD
    return realpathSync(expandedPath);
  } catch {
    // If realpathSync fails (e.g., file doesn't exist),
    // fall back to the expanded path
    return expandedPath;
  }
}

/**
 * Check if a path points to an existing file.
 *
 * This function uses {@link statSync} and will follow symlinks. It does not
 * require the path to be pre-resolved; any path accepted by {@link statSync}
 * can be used.
 *
 * @param filePath Path to check for an existing file
 */
function isFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    return stat.isFile();
=======
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
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
 * Check if a path points to an existing file.
 *
 * This function uses {@link statSync} and will follow symlinks. It does not
 * require the path to be pre-resolved; any path accepted by {@link statSync}
 * can be used.
 *
 * @param filePath Path to check for an existing file
 */
function isFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    return stat.isFile();
>>>>>>> 3a1c62d (chore: address comment)
  } catch {
    return false;
  }
}

/**
 * Find the first existing SSH key from default locations.
 * Resolves symlinks and returns the real path if found.
 */
function findDefaultSSHKey(): string | undefined {
  for (const keyPath of DEFAULT_SSH_KEYS) {
<<<<<<< HEAD
<<<<<<< HEAD
    const resolvedPath = resolveSymlink(keyPath);
    if (isFile(resolvedPath)) {
=======
    // Resolve symlinks (important for Windows where .ssh may be a junction)
    const resolvedPath = resolveSymlink(keyPath);
    if (fileExists(resolvedPath)) {
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
    const resolvedPath = resolveSymlink(keyPath);
    if (isFile(resolvedPath)) {
>>>>>>> 3a1c62d (chore: address comment)
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
  if (!isFile(sshConfigPath)) {
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
<<<<<<< HEAD
<<<<<<< HEAD
      if (isFile(resolvedPath)) {
=======
      if (fileExists(resolvedPath)) {
>>>>>>> 6844af2 (feat: implement ssh symbolic link)
=======
      if (isFile(resolvedPath)) {
>>>>>>> 3a1c62d (chore: address comment)
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

    // ProxyJump support for multi-hop SSH connections
    if (hostConfig.ProxyJump) {
      sshConfig.proxyJump = hostConfig.ProxyJump;
    }

    // ProxyCommand is not supported (requires shell execution)
    if (hostConfig.ProxyCommand) {
      console.error('Warning: ProxyCommand in SSH config is not supported by DBHub. Use ProxyJump instead.');
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

/**
 * Parse a jump host string in the format [user@]host[:port]
 * Examples:
 *   - "bastion.example.com" -> { host: "bastion.example.com", port: 22 }
 *   - "admin@bastion.example.com" -> { host: "bastion.example.com", port: 22, username: "admin" }
 *   - "bastion.example.com:2222" -> { host: "bastion.example.com", port: 2222 }
 *   - "admin@bastion.example.com:2222" -> { host: "bastion.example.com", port: 2222, username: "admin" }
 *
 * @param jumpHostStr The jump host string to parse
 * @returns Parsed JumpHost object
 */
export function parseJumpHost(jumpHostStr: string): JumpHost {
  let username: string | undefined;
  let host: string;
  let port = 22;

  let remaining = jumpHostStr.trim();

  // Extract username if present (user@...)
  const atIndex = remaining.indexOf('@');
  if (atIndex !== -1) {
    username = remaining.substring(0, atIndex);
    remaining = remaining.substring(atIndex + 1);
  }

  // Extract port if present (...:port)
  // Be careful with IPv6 addresses like [::1]:22
  if (remaining.startsWith('[')) {
    // IPv6 address in brackets
    const closeBracket = remaining.indexOf(']');
    if (closeBracket !== -1) {
      host = remaining.substring(1, closeBracket);
      const afterBracket = remaining.substring(closeBracket + 1);
      if (afterBracket.startsWith(':')) {
        port = parseInt(afterBracket.substring(1), 10) || 22;
      }
    } else {
      host = remaining;
    }
  } else {
    // Regular hostname or IPv4
    const lastColon = remaining.lastIndexOf(':');
    if (lastColon !== -1) {
      const potentialPort = remaining.substring(lastColon + 1);
      // Only treat as port if it's a valid number
      if (/^\d+$/.test(potentialPort)) {
        host = remaining.substring(0, lastColon);
        port = parseInt(potentialPort, 10);
      } else {
        host = remaining;
      }
    } else {
      host = remaining;
    }
  }

  return { host, port, username };
}

/**
 * Parse a ProxyJump string into an array of JumpHost objects.
 * ProxyJump can be a comma-separated list of hosts for multi-hop connections.
 *
 * @param proxyJump The ProxyJump string (e.g., "jump1.example.com,user@jump2.example.com:2222")
 * @returns Array of parsed JumpHost objects in connection order
 */
export function parseJumpHosts(proxyJump: string): JumpHost[] {
  if (!proxyJump || proxyJump.trim() === '' || proxyJump.toLowerCase() === 'none') {
    return [];
  }

  return proxyJump
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(parseJumpHost);
}