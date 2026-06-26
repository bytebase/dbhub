import { spawn, type ChildProcess } from 'child_process';
import { access } from 'fs/promises';
import { constants } from 'fs';
import type {
  SSHTunnelBackend,
  SSHTunnelEstablishRequest,
  SSHTunnelInfo,
} from '../types/ssh.js';
import { getFreePort } from './get-free-port.js';
import { waitForPort } from './wait-for-port.js';

const SSH_CLOSE_TIMEOUT_MS = 5_000;
const SSH_READY_TIMEOUT_MS = 30_000;

async function fileIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the ssh executable path.
 * Uses DBHUB_SSH_BIN when set; otherwise assumes `ssh` is on PATH.
 */
export async function resolveSshBinary(): Promise<string> {
  const fromEnv = process.env.DBHUB_SSH_BIN;
  if (fromEnv) {
    if (!(await fileIsExecutable(fromEnv))) {
      throw new Error(
        `DBHUB_SSH_BIN is set to '${fromEnv}' but the file is not executable`
      );
    }
    return fromEnv;
  }
  return 'ssh';
}

export function buildNativeSshArgs(
  request: SSHTunnelEstablishRequest,
  localPort: number
): string[] {
  if (!request.hostAlias) {
    throw new Error('Native SSH tunnel requires hostAlias');
  }

  const sshConfigPath = request.sshConfigPath;
  if (!sshConfigPath) {
    throw new Error('Native SSH tunnel requires sshConfigPath');
  }

  const args = [
    '-N',
    '-F',
    sshConfigPath,
    '-L',
    `127.0.0.1:${localPort}:${request.targetHost}:${request.targetPort}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
  ];

  const overrides = request.overrides;
  if (overrides?.user) {
    args.push('-l', overrides.user);
  }
  if (overrides?.port !== undefined) {
    args.push('-p', String(overrides.port));
  }
  if (overrides?.privateKey) {
    args.push('-i', overrides.privateKey);
  }
  if (overrides?.keepaliveInterval !== undefined && overrides.keepaliveInterval > 0) {
    args.push('-o', `ServerAliveInterval=${overrides.keepaliveInterval}`);
    args.push(
      '-o',
      `ServerAliveCountMax=${overrides.keepaliveCountMax ?? 3}`
    );
  }

  args.push(request.hostAlias);
  return args;
}

/**
 * SSH tunnel via the system OpenSSH client.
 * Delegates ProxyJump, ProxyCommand, and per-host auth to ~/.ssh/config.
 */
export class NativeSSHTunnel implements SSHTunnelBackend {
  private child: ChildProcess | null = null;
  private tunnelInfo: SSHTunnelInfo | null = null;
  private isConnected = false;
  private stderrChunks: string[] = [];

  getMode(): 'native' {
    return 'native';
  }

  async establish(request: SSHTunnelEstablishRequest): Promise<SSHTunnelInfo> {
    if (this.isConnected) {
      throw new Error('SSH tunnel is already established');
    }

    this.isConnected = true;
    this.stderrChunks = [];

    const sshBinary = await resolveSshBinary();
    const localPort = request.localPort ?? (await getFreePort());
    const args = buildNativeSshArgs(request, localPort);
    const abortController = new AbortController();

    try {
      this.child = spawn(sshBinary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) {
          this.stderrChunks.push(text);
          console.error(`ssh: ${text}`);
        }
      });

      const exitPromise = new Promise<never>((_, reject) => {
        this.child?.once('error', (err) => {
          abortController.abort();
          reject(new Error(`Failed to start ssh: ${err.message}`));
        });

        this.child?.once('exit', (code, signal) => {
          abortController.abort();
          const detail = this.formatStderr();
          if (signal) {
            reject(
              new Error(
                `ssh exited with signal ${signal}${detail ? `: ${detail}` : ''}`
              )
            );
            return;
          }
          reject(
            new Error(
              `ssh exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`
            )
          );
        });
      });

      await Promise.race([
        waitForPort(localPort, {
          timeoutMs: SSH_READY_TIMEOUT_MS,
          signal: abortController.signal,
        }),
        exitPromise,
      ]);

      this.tunnelInfo = {
        localPort,
        targetHost: request.targetHost,
        targetPort: request.targetPort,
      };

      console.error(
        `SSH tunnel established (native): localhost:${localPort} → ${request.targetHost}:${request.targetPort} via ${request.hostAlias}`
      );

      return this.tunnelInfo;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.child) {
      this.isConnected = false;
      this.tunnelInfo = null;
      return;
    }

    const child = this.child;
    this.child = null;
    this.tunnelInfo = null;
    this.isConnected = false;

    await new Promise<void>((resolve) => {
      let settled = false;

      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore errors during forced shutdown
        }
        finish();
      }, SSH_CLOSE_TIMEOUT_MS);

      child.once('exit', () => {
        clearTimeout(timer);
        finish();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        finish();
      }
    });

    console.error('SSH tunnel closed (native)');
  }

  getTunnelInfo(): SSHTunnelInfo | null {
    return this.tunnelInfo;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  private formatStderr(): string {
    return this.stderrChunks.join(' ').trim();
  }
}
