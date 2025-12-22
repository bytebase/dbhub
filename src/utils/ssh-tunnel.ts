import { Client, ConnectConfig } from 'ssh2';
import { readFileSync } from 'fs';
import { Server, createServer } from 'net';
import type { SSHTunnelConfig, SSHTunnelOptions, SSHTunnelInfo } from '../types/ssh.js';
import { resolveSymlink } from './ssh-config-parser.js';

/**
 * SSH Tunnel implementation for secure database connections
 */
export class SSHTunnel {
  private sshClient: Client | null = null;
  private localServer: Server | null = null;
  private tunnelInfo: SSHTunnelInfo | null = null;
  private isConnected: boolean = false;

  /**
   * Establish an SSH tunnel
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

    return new Promise((resolve, reject) => {
      this.sshClient = new Client();

      // Build SSH connection config
      const sshConfig: ConnectConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
      };

      // Configure authentication
      if (config.password) {
        sshConfig.password = config.password;
      } else if (config.privateKey) {
        try {
          // Resolve symlinks (important for Windows where .ssh may be a junction)
          const resolvedKeyPath = resolveSymlink(config.privateKey);
          const privateKey = readFileSync(resolvedKeyPath);
          sshConfig.privateKey = privateKey;
          if (config.passphrase) {
            sshConfig.passphrase = config.passphrase;
          }
        } catch (error) {
          reject(new Error(`Failed to read private key file: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
      } else {
        reject(new Error('Either password or privateKey must be provided for SSH authentication'));
        return;
      }

      // Handle SSH connection errors
      this.sshClient.on('error', (err) => {
        this.cleanup();
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      // When SSH connection is ready, create the tunnel
      this.sshClient.on('ready', () => {
        console.error('SSH connection established');

        // Create local server for the tunnel
        this.localServer = createServer((localSocket) => {
          this.sshClient!.forwardOut(
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

              // Handle stream errors
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

        // Listen on local port
        const localPort = options.localPort || 0;
        this.localServer.listen(localPort, '127.0.0.1', () => {
          const address = this.localServer!.address();
          if (!address || typeof address === 'string') {
            this.cleanup();
            reject(new Error('Failed to get local server address'));
            return;
          }

          this.tunnelInfo = {
            localPort: address.port,
            targetHost: options.targetHost,
            targetPort: options.targetPort,
          };

          this.isConnected = true;
          console.error(`SSH tunnel established: localhost:${address.port} -> ${options.targetHost}:${options.targetPort}`);
          resolve(this.tunnelInfo);
        });

        // Handle local server errors
        this.localServer.on('error', (err) => {
          this.cleanup();
          reject(new Error(`Local server error: ${err.message}`));
        });
      });

      // Connect to SSH server
      this.sshClient.connect(sshConfig);
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
      this.isConnected = false;
      console.error('SSH tunnel closed');
      resolve();
    });
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    if (this.localServer) {
      this.localServer.close();
      this.localServer = null;
    }

    if (this.sshClient) {
      this.sshClient.end();
      this.sshClient = null;
    }

    this.tunnelInfo = null;
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