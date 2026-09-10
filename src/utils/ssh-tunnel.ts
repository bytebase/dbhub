import { Client, ConnectConfig } from 'ssh2';
import { readFileSync } from 'fs';
import { Server, createServer } from 'net';
import type { Duplex } from 'stream';
import type { SSHTunnelConfig, SSHTunnelOptions, SSHTunnelInfo, JumpHost } from '../types/ssh.js';
import { resolveSymlink, parseJumpHosts } from './ssh-config-parser.js';
import {
  decideHostKey,
  getDefaultKnownHostsFiles,
  DEFAULT_HOST_KEY_CHECK_MODE,
  type HostKeyVerifierOptions,
} from './ssh-host-key.js';

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

      // Validate authentication
      if (!config.password && !privateKeyBuffer) {
        throw new Error('Either password or privateKey must be provided for SSH authentication');
      }

      // Host key verification policy (MITM defense; CWE-295). Applied to every
      // hop and the final target. A pinned fingerprint, when configured, is the
      // target host's anchor only — jump hops verify via known_hosts.
      const verificationBase: HostKeyVerifierOptions = {
        mode: config.hostKeyCheck ?? DEFAULT_HOST_KEY_CHECK_MODE,
        knownHostsFiles:
          config.knownHostsFiles && config.knownHostsFiles.length > 0
            ? config.knownHostsFiles
            : getDefaultKnownHostsFiles(),
        pinnedFingerprint: config.hostFingerprint,
      };

      // Establish the SSH connection chain
      const finalClient = await this.establishChain(jumpHosts, config, privateKeyBuffer, verificationBase);

      // Create local server for the tunnel
      return await this.createLocalTunnel(finalClient, options);
    } catch (error) {
      this.cleanup();
      throw error;
    }
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
    verificationBase: HostKeyVerifierOptions
  ): Promise<Client> {
    let previousStream: Duplex | undefined;

    // Jump hops are verified against known_hosts (and the configured mode), but
    // never against the target's pinned fingerprint — that fingerprint belongs
    // to the final target host only.
    const hopVerification: HostKeyVerifierOptions = { ...verificationBase, pinnedFingerprint: undefined };

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
      const hopPrivateKey = jumpHost.privateKey ? this.loadPrivateKey(jumpHost.privateKey) : privateKey;
      const hopPassword = targetConfig.password;
      const hopPassphrase = jumpHost.passphrase ?? targetConfig.passphrase;

      let client: Client | null = null;
      let forwardStream: Duplex;
      try {
        client = await this.connectToHost(
          {
            host: jumpHost.host,
            port: jumpHost.port,
            username: jumpHost.username || targetConfig.username,
          },
          hopPassword,
          hopPrivateKey,
          hopPassphrase,
          previousStream,
          `jump host ${i + 1}`,
          targetConfig.keepaliveInterval,
          targetConfig.keepaliveCountMax,
          hopVerification
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
      targetConfig.password,
      privateKey,
      targetConfig.passphrase,
      previousStream,
      jumpHosts.length > 0 ? 'target host' : undefined,
      targetConfig.keepaliveInterval,
      targetConfig.keepaliveCountMax,
      verificationBase
    );

    this.sshClients.push(finalClient);
    return finalClient;
  }

  /**
   * Connect to a single SSH host.
   */
  private connectToHost(
    hostInfo: { host: string; port: number; username: string },
    password: string | undefined,
    privateKey: Buffer | undefined,
    passphrase: string | undefined,
    sock: Duplex | undefined,
    label: string | undefined,
    keepaliveInterval: number | undefined,
    keepaliveCountMax: number | undefined,
    verification: HostKeyVerifierOptions
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();

      // Host key verification (MITM defense; CWE-295). ssh2 accepts any key
      // when no hostVerifier is set, so we always supply one and fail closed.
      // The decision is synchronous; a rejection reason is captured here so the
      // 'error' handler can surface it instead of ssh2's generic message.
      let rejectionReason: string | undefined;
      const sshConfig: ConnectConfig = {
        host: hostInfo.host,
        port: hostInfo.port,
        username: hostInfo.username,
        hostVerifier: (key: Buffer): boolean => {
          const decision = decideHostKey(verification, hostInfo.host, hostInfo.port, key);
          if (decision.accepted) {
            if (verification.mode !== 'strict') {
              console.error(`SSH host key: ${decision.reason}`);
            }
            return true;
          }
          rejectionReason = decision.reason;
          return false;
        },
      };

      if (password) {
        sshConfig.password = password;
      }
      if (privateKey) {
        sshConfig.privateKey = privateKey;
        if (passphrase) {
          sshConfig.passphrase = passphrase;
        }
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
        // A rejected host key surfaces as a generic ssh2 handshake error; prefer
        // the specific verification reason we captured so operators can act on it.
        const detail = rejectionReason
          ? `${rejectionReason}`
          : `${err.message}`;
        reject(new Error(`SSH connection error${label ? ` (${label})` : ''}: ${detail}`));
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