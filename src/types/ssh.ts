/**
 * SSH Tunnel Configuration Types
 */

export interface SSHTunnelConfig {
  /** SSH server hostname */
  host: string;

  /** SSH server port (default: 22) */
  port?: number;

  /** SSH username */
  username: string;

  /** SSH password (for password authentication) */
  password?: string;

  /** Path to SSH private key file */
  privateKey?: string;

  /** Passphrase for SSH private key */
  passphrase?: string;

  /**
   * ProxyJump configuration for multi-hop SSH connections.
   * Accepts a comma-separated string of hosts (e.g., "jump1.example.com,jump2.example.com"),
   * which is parsed internally into an array of JumpHost objects.
   * Each host can include optional user and port: "user@host:port"
   */
  proxyJump?: string;

  /** Interval in seconds between keepalive packets sent to the SSH server (default: 0 = disabled) */
  keepaliveInterval?: number;

  /** Maximum number of missed keepalive responses before disconnecting (default: 3) */
  keepaliveCountMax?: number;

  /**
   * Host key verification mode (defends against MITM on the tunnel; CWE-295):
   * - `strict` (default): only a key matching a known_hosts entry or the pinned
   *   fingerprint is accepted; unknown/changed/revoked keys are rejected.
   * - `accept-new`: trust an unknown host on first use and remember it; a known
   *   host must still match.
   * - `off`: accept any key without verification (insecure opt-out).
   * When omitted, the tunnel uses `strict`.
   */
  hostKeyCheck?: import("../utils/ssh-host-key.js").HostKeyCheckMode;

  /**
   * known_hosts file path(s) consulted for verification (and appended to under
   * `accept-new`). When omitted, OpenSSH's defaults (`~/.ssh/known_hosts`,
   * `~/.ssh/known_hosts2`) are used.
   */
  knownHostsFiles?: string[];

  /**
   * Optional pinned SSH host key fingerprint (`SHA256:...`) for the target
   * server. When set it is the sole trust anchor for the target host, taking
   * priority over known_hosts.
   */
  hostFingerprint?: string;

  /**
   * Fully-resolved jump-host chain (in connection order), produced by
   * `resolveJumpHosts` from `proxyJump` + `~/.ssh/config`. When present, the tunnel
   * uses these (with their per-hop credentials) instead of re-parsing `proxyJump`
   * as literal hosts.
   */
  resolvedJumpHosts?: JumpHost[];
}

/**
 * Parsed jump host information
 */
export interface JumpHost {
  /** Jump host hostname */
  host: string;

  /** Jump host port (default: 22) */
  port: number;

  /** Jump host username (inherited from target if not specified) */
  username?: string;

  /** Jump host private key path/content, resolved from its own `~/.ssh/config` entry */
  privateKey?: string;

  /** Passphrase for the jump host's private key */
  passphrase?: string;
}

export interface SSHTunnelOptions {
  /** Target database host (as seen from SSH server) */
  targetHost: string;
  
  /** Target database port */
  targetPort: number;
  
  /** Local port to bind the tunnel (0 for dynamic allocation) */
  localPort?: number;
}

export interface SSHTunnelInfo {
  /** Local port where the tunnel is listening */
  localPort: number;
  
  /** Original target host */
  targetHost: string;
  
  /** Original target port */
  targetPort: number;
}