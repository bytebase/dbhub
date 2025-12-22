import { Client, ConnectConfig } from 'ssh2';
import { readFileSync } from 'fs';
import { Server, createServer } from 'net';
import type { Duplex } from 'stream';
import type { SSHTunnelConfig, SSHTunnelOptions, SSHTunnelInfo, JumpHost } from '../types/ssh.js';
import { resolveSymlink, parseJumpHosts } from './ssh-config-parser.js';

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
      // Parse jump hosts if ProxyJump is configured
      const jumpHosts = config.proxyJump ? parseJumpHosts(config.proxyJump) : [];

      // Read the private key once (shared by all connections)
      let privateKeyBuffer: Buffer | undefined;
      if (config.privateKey) {
        try {
          const resolvedKeyPath = resolveSymlink(config.privateKey);
          privateKeyBuffer = readFileSync(resolvedKeyPath);
        } catch (error) {
          throw new Error(`Failed to read private key file: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Validate authentication
      if (!config.password && !privateKeyBuffer) {
        throw new Error('Either password or privateKey must be provided for SSH authentication');
      }

      // Establish the SSH connection chain
      const finalClient = await this.establishChain(jumpHosts, config, privateKeyBuffer);

      // Create local server for the tunnel
      return await this.createLocalTunnel(finalClient, options);
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  /**
   * Establish a chain of SSH connections through jump hosts.
   * @returns The final SSH client connected to the target host
   */
  private async establishChain(
    jumpHosts: JumpHost[],
    targetConfig: SSHTunnelConfig,
    privateKey: Buffer | undefined
  ): Promise<Client> {
    let previousStream: Duplex | undefined;

    // Connect through each jump host
    for (let i = 0; i < jumpHosts.length; i++) {
      const jumpHost = jumpHosts[i];
      const nextHost = i + 1 < jumpHosts.length
        ? jumpHosts[i + 1]
        : { host: targetConfig.host, port: targetConfig.port || 22 };

      let client: Client | null = null;
      let forwardStream: Duplex;
      try {
        client = await this.connectToHost(
          {
            host: jumpHost.host,
            port: jumpHost.port,
            username: jumpHost.username || targetConfig.username,
          },
          targetConfig.password,
          privateKey,
          targetConfig.passphrase,
          previousStream,
          `jump host ${i + 1}`
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
      jumpHosts.length > 0 ? 'target host' : undefined
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
    label: string | undefined
  ): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();

      const sshConfig: ConnectConfig = {
        host: hostInfo.host,
        port: hostInfo.port,
        username: hostInfo.username,
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