// `utils` is not detectable as a named export of the CommonJS ssh2 module under ESM,
// so it is read off the default export.
import ssh2, { Client, ConnectConfig, ParsedKey } from 'ssh2';
import { existsSync, readFileSync } from 'fs';
import { Server, createServer } from 'net';
import type { Duplex } from 'stream';
import type { SSHTunnelConfig, SSHTunnelOptions, SSHTunnelInfo, JumpHost } from '../types/ssh.js';
import { resolveSymlink, parseJumpHosts } from './ssh-config-parser.js';

/** Credentials offered to a single SSH host. */
interface SSHHostAuth {
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
  /** The key came from ~/.ssh/config rather than explicit DBHub configuration */
  privateKeyDiscovered?: boolean;
  agent?: string;
}

/**
 * SSH Tunnel implementation for secure database connections.
 * Supports ProxyJump for multi-hop SSH connections through bastion/jump hosts.
 */
export class SSHTunnel {
  private sshClients: Client[] = []; // All SSH clients in the chain
  private localServer: Server | null = null;
  private tunnelInfo: SSHTunnelInfo | null = null;
  private isConnected: boolean = false;

  /**
   * Establish an SSH tunnel, optionally through jump hosts (ProxyJump).
   * @param config SSH connection configuration
   * @param options Tunnel options including target host and port
   * @returns Promise resolving to tunnel information including local port
   */
  async establish(
    config: SSHTunnelConfig,
    options: SSHTunnelOptions
  ): Promise<SSHTunnelInfo> {
    if (this.isConnected) {
      throw new Error('SSH tunnel is already established');
    }

    // Set isConnected immediately to prevent concurrent calls
    this.isConnected = true;

    try {
      // Use the fully-resolved jump-host chain when available (per-hop config/auth
      // from ~/.ssh/config); otherwise fall back to literal ProxyJump parsing.
      const jumpHosts = config.resolvedJumpHosts
        ?? (config.proxyJump ? parseJumpHosts(config.proxyJump) : []);

      // Read the target's private key once.
      const privateKeyBuffer = config.privateKey ? this.loadPrivateKey(config.privateKey) : undefined;

      const agent = this.resolveAgent(config.agent);

      // Validate authentication (an SSH agent counts as an auth method)
      if (!config.password && !privateKeyBuffer && !agent) {
        throw new Error('Either password, privateKey, or an SSH agent (agent or SSH_AUTH_SOCK) must be provided for SSH authentication');
      }

      // Establish the SSH connection chain
      const finalClient = await this.establishChain(jumpHosts, config, privateKeyBuffer, agent);

      // Create local server for the tunnel
      return await this.createLocalTunnel(finalClient, options);
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  /**
   * Pick the SSH agent socket: an explicitly configured one wins over the ambient
   * SSH_AUTH_SOCK. A configured socket that does not exist is an error; a stale
   * SSH_AUTH_SOCK is ignored, since the user never asked DBHub to use it.
   */
  private resolveAgent(configuredAgent: string | undefined): string | undefined {
    if (configuredAgent) {
      if (!this.agentSocketExists(configuredAgent)) {
        throw new Error(`SSH agent socket not found: ${configuredAgent}`);
      }
      return configuredAgent;
    }

    const ambientAgent = process.env.SSH_AUTH_SOCK;
    if (!ambientAgent) {
      return undefined;
    }
    if (!this.agentSocketExists(ambientAgent)) {
      console.warn(`Ignoring SSH_AUTH_SOCK: no SSH agent socket at ${ambientAgent}`);
      return undefined;
    }
    return ambientAgent;
  }

  /**
   * Windows agents are named pipes or Pageant rather than files, so only Unix
   * socket paths are checked.
   */
  private agentSocketExists(agent: string): boolean {
    return process.platform === 'win32' || existsSync(agent);
  }

  /**
   * Why ssh2 would refuse this key, mirroring the checks its connect() runs before
   * trying any auth method, or undefined when the key is usable.
   */
  private unusableKeyReason(privateKey: Buffer, passphrase: string | undefined): string | undefined {
    const parsed: unknown = ssh2.utils.parseKey(privateKey, passphrase);
    if (parsed instanceof Error) {
      return parsed.message;
    }
    const key = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
    // Typed as string, but null for a public key, e.g. an IdentityFile pointing at a
    // .pub file (the 1Password way to pick which agent key to offer).
    if ((key.getPrivatePEM() as string | null) === null) {
      return 'not a private key';
    }
    return undefined;
  }

  /**
   * Load an SSH private key, supporting both a file path (with symlink resolution)
   * and base64-encoded key content.
   */
  private loadPrivateKey(key: string): Buffer {
    try {
      const resolvedKeyPath = resolveSymlink(key);
      return readFileSync(resolvedKeyPath);
    } catch {
      // Not a readable file — try base64 decode
      try {
        const decoded = Buffer.from(key, 'base64');
        const text = decoded.toString('utf8');
        if (text.includes('PRIVATE KEY')) {
          return decoded;
        }
        throw new Error('SSH key is neither a valid file path nor a base64-encoded private key');
      } catch (decodeError) {
        if (decodeError instanceof Error && decodeError.message.includes('neither a valid file path')) {
          throw decodeError;
        }
        throw new Error('SSH key is neither a valid file path nor a base64-encoded private key');
      }
    }
  }

  /**
   * Establish a chain of SSH connections through jump hosts.
   * @returns The final SSH client connected to the target host
   */
  private async establishChain(
    jumpHosts: JumpHost[],
    targetConfig: SSHTunnelConfig,
    privateKey: Buffer | undefined,
    agent: string | undefined
  ): Promise<Client> {
    let previousStream: Duplex | undefined;

    // Connect through each jump host
    for (let i = 0; i < jumpHosts.length; i++) {
      const jumpHost = jumpHosts[i];
      const nextHost = i + 1 < jumpHosts.length
        ? jumpHosts[i + 1]
        : { host: targetConfig.host, port: targetConfig.port || 22 };

      // Per-hop credentials: use a hop's own resolved key when it has one, falling
      // back to the target's key otherwise. The target password is always offered as
      // a fallback (as before) — a hop may carry only a default-discovered key, so
      // suppressing the password on "has a key" would break password auth.
      // A hop's own key always comes from ~/.ssh/config.
      const hopAuth: SSHHostAuth = {
        password: targetConfig.password,
        privateKey: jumpHost.privateKey ? this.loadPrivateKey(jumpHost.privateKey) : privateKey,
        passphrase: jumpHost.passphrase ?? targetConfig.passphrase,
        privateKeyDiscovered: jumpHost.privateKey ? true : targetConfig.privateKeyDiscovered,
        agent,
      };

      let client: Client | null = null;
      let forwardStream: Duplex;
      try {
        client = await this.connectToHost(
          {
            host: jumpHost.host,
            port: jumpHost.port,
            username: jumpHost.username || targetConfig.username,
          },
          hopAuth,
          previousStream,
          `jump host ${i + 1}`,
          targetConfig.keepaliveInterval,
          targetConfig.keepaliveCountMax
        );

        // Forward to the next host
        console.error(`  → Forwarding through ${jumpHost.host}:${jumpHost.port} to ${nextHost.host}:${nextHost.port}`);
        forwardStream = await this.forwardTo(client, nextHost.host, nextHost.port);
      } catch (error) {
        if (client) {
          try {
            client.end();
          } catch {
            // Ignore errors during cleanup of partially established client
          }
        }
        throw error;
      }

      this.sshClients.push(client);
      previousStream = forwardStream;
    }

    // Connect to the final target
    const finalClient = await this.connectToHost(
      {
        host: targetConfig.host,
        port: targetConfig.port || 22,
        username: targetConfig.username,
      },
      {
        password: targetConfig.password,
        privateKey,
        passphrase: targetConfig.passphrase,
        privateKeyDiscovered: targetConfig.privateKeyDiscovered,
        agent,
      },
      previousStream,
      jumpHosts.length > 0 ? 'target host' : undefined,
      targetConfig.keepaliveInterval,
      targetConfig.keepaliveCountMax
    );

    this.sshClients.push(finalClient);
    return finalClient;
  }

  /**
   * Connect to a single SSH host.
   */
  private connectToHost(
    hostInfo: { host: string; port: number; username: string },
    auth: SSHHostAuth,
    sock: Duplex | undefined,
    label: string | undefined,
    keepaliveInterval?: number,
    keepaliveCountMax?: number
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();

      const sshConfig: ConnectConfig = {
        host: hostInfo.host,
        port: hostInfo.port,
        username: hostInfo.username,
      };

      const { password, privateKey, passphrase, agent } = auth;

      if (password) {
        sshConfig.password = password;
      }
      if (privateKey) {
        // ssh2 throws on a key it cannot parse (e.g. an encrypted key without a
        // passphrase) before trying any other method. A key picked up from
        // ~/.ssh/config is skipped in that case when another method is available,
        // like ssh does. An explicitly configured key still fails loudly.
        const canSkip = auth.privateKeyDiscovered && Boolean(password || agent);
        const unusableReason = canSkip ? this.unusableKeyReason(privateKey, passphrase) : undefined;
        if (unusableReason) {
          const desc = label || `${hostInfo.host}:${hostInfo.port}`;
          console.warn(
            `Skipping unusable SSH private key from ~/.ssh/config for ${desc} (${unusableReason}).`
          );
        } else {
          sshConfig.privateKey = privateKey;
          if (passphrase) {
            sshConfig.passphrase = passphrase;
          }
        }
      }
      // Offer the SSH agent (ssh-agent, 1Password, etc.) when one is available.
      // ssh2 tries it after any explicit password/key.
      if (agent) {
        sshConfig.agent = agent;
      }
      if (sock) {
        sshConfig.sock = sock;
      }
      if (keepaliveInterval !== undefined) {
        if (Number.isNaN(keepaliveInterval) || keepaliveInterval < 0) {
          const desc = label || `${hostInfo.host}:${hostInfo.port}`;
          console.warn(
            `Invalid SSH keepaliveInterval (${keepaliveInterval}) for ${desc}; ` +
            'keepalive configuration will be ignored.'
          );
        } else if (keepaliveInterval > 0) {
          sshConfig.keepaliveInterval = keepaliveInterval * 1000; // Convert seconds to milliseconds
          sshConfig.keepaliveCountMax = keepaliveCountMax ?? 3;
        }
      }

      const onError = (err: Error) => {
        client.removeListener('ready', onReady);
        client.destroy();
        reject(new Error(`SSH connection error${label ? ` (${label})` : ''}: ${err.message}`));
      };

      const onReady = () => {
        client.removeListener('error', onError);
        const desc = label || `${hostInfo.host}:${hostInfo.port}`;
        console.error(`SSH connection established: ${desc}`);
        resolve(client);
      };

      client.on('error', onError);
      client.on('ready', onReady);

      client.connect(sshConfig);
    });
  }

  /**
   * Forward a connection through an SSH client to a target host.
   */
  private forwardTo(client: Client, targetHost: string, targetPort: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
        if (err) {
          reject(new Error(`SSH forward error: ${err.message}`));
          return;
        }
        resolve(stream as Duplex);
      });
    });
  }

  /**
   * Create the local server that tunnels connections to the database.
   */
  private createLocalTunnel(
    sshClient: Client,
    options: SSHTunnelOptions
  ): Promise<SSHTunnelInfo> {
    return new Promise((resolve, reject) => {
      let settled = false;
      
      this.localServer = createServer((localSocket) => {
        sshClient.forwardOut(
          '127.0.0.1',
          0,
          options.targetHost,
          options.targetPort,
          (err, stream) => {
            if (err) {
              console.error('SSH forward error:', err);
              localSocket.end();
              return;
            }

            // Pipe data between local socket and SSH stream
            localSocket.pipe(stream).pipe(localSocket);

            stream.on('error', (err) => {
              console.error('SSH stream error:', err);
              localSocket.end();
            });

            localSocket.on('error', (err) => {
              console.error('Local socket error:', err);
              stream.end();
            });
          }
        );
      });

      // Register error listener before calling listen() to catch all errors
      this.localServer.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Local server error: ${err.message}`));
        } else {
          // If an error occurs after the tunnel is established, log it and clean up
          console.error('Local server error after tunnel established:', err);
          this.cleanup();
        }
      });

      const localPort = options.localPort || 0;
      this.localServer.listen(localPort, '127.0.0.1', () => {
        const address = this.localServer!.address();
        if (!address || typeof address === 'string') {
          if (!settled) {
            settled = true;
            reject(new Error('Failed to get local server address'));
          }
          return;
        }

        this.tunnelInfo = {
          localPort: address.port,
          targetHost: options.targetHost,
          targetPort: options.targetPort,
        };

        console.error(`SSH tunnel established: localhost:${address.port} → ${options.targetHost}:${options.targetPort}`);
        settled = true;
        resolve(this.tunnelInfo);
      });
    });
  }

  /**
   * Close the SSH tunnel and clean up resources
   */
  async close(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    return new Promise((resolve) => {
      this.cleanup();
      console.error('SSH tunnel closed');
      resolve();
    });
  }

  /**
   * Clean up resources. Closes all SSH clients in reverse order (innermost first).
   */
  private cleanup(): void {
    if (this.localServer) {
      this.localServer.close();
      this.localServer = null;
    }

    // Close SSH clients in reverse order (innermost connection first)
    for (let i = this.sshClients.length - 1; i >= 0; i--) {
      try {
        this.sshClients[i].end();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.sshClients = [];

    this.tunnelInfo = null;
    this.isConnected = false;
  }

  /**
   * Get current tunnel information
   */
  getTunnelInfo(): SSHTunnelInfo | null {
    return this.tunnelInfo;
  }

  /**
   * Check if tunnel is connected
   */
  getIsConnected(): boolean {
    return this.isConnected;
  }
}