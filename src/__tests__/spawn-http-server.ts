import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SpawnedHttpServer {
  port: number;
  /** Root URL on the host the server was reached at */
  baseUrl: string;
  /** Everything the server has written to stdout/stderr so far */
  logs: string[];
  /** Kill the server and remove its database file and working directory */
  stop(): Promise<void>;
}

/**
 * Start DBHub's HTTP transport as a child process on a random port, against a
 * fresh SQLite file named by the DSN env var, and wait until it answers.
 *
 * @param bindHost passed as DBHUB_HOST and used to reach the server; omitted,
 *   the server binds its default and is reached through localhost
 */
export async function spawnHttpServer(bindHost?: string): Promise<SpawnedHttpServer> {
  const host = bindHost ?? 'localhost';
  // Randomize the port to avoid conflicts with other test files and stray servers
  const port = 20000 + Math.floor(Math.random() * 20000);
  const baseUrl = `http://${host}:${port}`;
  const dbPath = path.join(os.tmpdir(), `dbhub_http_test_${Date.now()}_${Math.random().toString(36).slice(2, 11)}.db`);

  // The server discovers ./dbhub.toml relative to its own cwd, and TOML config
  // outranks the DSN env var below. Running from the repo root would therefore
  // silently ignore DSN and connect to whatever a developer's local (gitignored)
  // dbhub.toml names, so the server would fail to start on any machine that has
  // one. Spawn from an empty directory to isolate config discovery.
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dbhub_http_cwd_'));

  // Invoke tsx directly via node rather than `pnpm dev`: `pnpm dev` runs the
  // backend and the Vite frontend under `concurrently`, and the frontend is both
  // unnecessary here and leaked a stray dev server on every run. It also avoids
  // pnpm.cmd resolution issues on Windows.
  const tsxCli = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = path.resolve(process.cwd(), 'src', 'index.ts');

  const serverProcess = spawn(process.execPath, [tsxCli, entry, '--transport=http'], {
    cwd: isolatedCwd,
    env: {
      ...process.env,
      DSN: `sqlite://${dbPath}`,
      PORT: port.toString(),
      NODE_ENV: 'test',
      ...(bindHost ? { DBHUB_HOST: bindHost } : {}),
    },
    stdio: 'pipe',
  });

  // Retained for the failure message below, and for tests of what the server
  // logs: without the server's own logs, a startup failure surfaces only as a
  // timeout with no indication of the cause.
  const logs: string[] = [];
  serverProcess.stdout?.on('data', (data) => logs.push(data.toString()));
  serverProcess.stderr?.on('data', (data) => logs.push(data.toString()));

  const stop = async (): Promise<void> => {
    if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
      serverProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        // Without clearing this on normal exit, the pending timer keeps
        // the Vitest process alive until the 5s tail elapses.
        const killTimeout = setTimeout(() => {
          serverProcess.kill('SIGKILL');
          resolve();
        }, 5000);
        serverProcess.on('exit', () => {
          clearTimeout(killTimeout);
          resolve();
        });
      });
    }
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  };

  // Wait for /healthz to respond on the expected host (poll every 250ms, ~30s total)
  for (let i = 0; i < 120; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) {
        return { port, baseUrl, logs, stop };
      }
    } catch {
      // not ready yet
    }
  }

  await stop();
  throw new Error(`Server did not answer on ${host}:${port} within timeout. Logs:\n${logs.join('')}`);
}
