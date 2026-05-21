import { describe, it, expect } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Graceful shutdown', () => {
  async function getEphemeralPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          srv.close();
          reject(new Error('Failed to acquire ephemeral port'));
        }
      });
    });
  }

  async function waitForServerReady(baseUrl: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/healthz`);
        if (response.ok) return;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Server did not become ready in time');
  }

  async function startServer(): Promise<{ proc: ChildProcess; dbPath: string; port: number }> {
    const port = await getEphemeralPort();
    const dbPath = path.join(
      os.tmpdir(),
      `graceful_shutdown_${Date.now()}_${Math.random().toString(36).slice(2, 11)}.db`
    );
    // Spawn tsx directly (no `pnpm dev:backend` wrapper) so SIGTERM/SIGINT
    // reach the Node process unmediated by pnpm / concurrently.
    const proc = spawn(
      'node',
      ['--import', 'tsx/esm', 'src/index.ts', '--transport=http'],
      {
        env: {
          ...process.env,
          DSN: `sqlite://${dbPath}`,
          PORT: port.toString(),
          NODE_ENV: 'test',
        },
        stdio: 'pipe',
      }
    );
    proc.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
    return { proc, dbPath, port };
  }

  async function waitForExit(
    proc: ChildProcess,
    timeoutMs: number
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ code: null, signal: null, timedOut: true });
      }, timeoutMs);
      proc.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
    });
  }

  async function cleanup(proc: ChildProcess, dbPath: string): Promise<void> {
    // `proc.killed` flips true as soon as we send any signal, even before
    // the child has exited — check `exitCode`/`signalCode` to know whether
    // the process is actually gone, and force-kill otherwise to avoid leaks.
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await waitForExit(proc, 5_000);
    }
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }

  it('exits with code 0 within a few seconds of SIGTERM in HTTP mode', async () => {
    const { proc, dbPath, port } = await startServer();
    try {
      await waitForServerReady(`http://localhost:${port}`);
      proc.kill('SIGTERM');
      const result = await waitForExit(proc, 10_000);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    } finally {
      await cleanup(proc, dbPath);
    }
  }, 60_000);

  it('exits with code 0 within a few seconds of SIGINT in HTTP mode', async () => {
    const { proc, dbPath, port } = await startServer();
    try {
      await waitForServerReady(`http://localhost:${port}`);
      proc.kill('SIGINT');
      const result = await waitForExit(proc, 10_000);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    } finally {
      await cleanup(proc, dbPath);
    }
  }, 60_000);
});
