import { describe, it, expect } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Graceful shutdown', () => {
  const testPort = 3099;

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

  function startServer(): { proc: ChildProcess; dbPath: string } {
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
          PORT: testPort.toString(),
          NODE_ENV: 'test',
        },
        stdio: 'pipe',
      }
    );
    proc.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
    return { proc, dbPath };
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

  it('exits with code 0 within a few seconds of SIGTERM in HTTP mode', async () => {
    const { proc, dbPath } = startServer();
    try {
      await waitForServerReady(`http://localhost:${testPort}`);
      proc.kill('SIGTERM');
      const result = await waitForExit(proc, 10_000);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    } finally {
      if (!proc.killed) proc.kill('SIGKILL');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  }, 60_000);

  it('exits with code 0 within a few seconds of SIGINT in HTTP mode', async () => {
    const { proc, dbPath } = startServer();
    try {
      await waitForServerReady(`http://localhost:${testPort}`);
      proc.kill('SIGINT');
      const result = await waitForExit(proc, 10_000);
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    } finally {
      if (!proc.killed) proc.kill('SIGKILL');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
  }, 60_000);
});
