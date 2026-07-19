import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('HTTP bind host integration', () => {
  let serverProcess: ChildProcess | null = null;
  let testDbPath: string;
  let isolatedCwd: string;
  const testPort = 3002;
  const testHost = '127.0.0.1';
  const startupLogs: string[] = [];

  beforeAll(async () => {
    testDbPath = path.join(os.tmpdir(), `bind_host_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.db`);

    // The server discovers ./dbhub.toml relative to its own cwd, and TOML config
    // outranks the DSN env var below. Running from the repo root would therefore
    // silently ignore DSN and connect to whatever a developer's local (gitignored)
    // dbhub.toml names, so the server would fail to start on any machine that has
    // one. Spawn from an empty directory to isolate config discovery.
    isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bind_host_cwd_'));

    // Invoke tsx directly via node to avoid pnpm.cmd resolution issues on Windows.
    const tsxCli = path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const entry = path.resolve(process.cwd(), 'src', 'index.ts');

    serverProcess = spawn(process.execPath, [tsxCli, entry, '--transport=http'], {
      cwd: isolatedCwd,
      env: {
        ...process.env,
        DSN: `sqlite://${testDbPath}`,
        DBHUB_HOST: testHost,
        PORT: testPort.toString(),
        NODE_ENV: 'test',
      },
      stdio: 'pipe',
    });

    serverProcess.stdout?.on('data', (data) => {
      startupLogs.push(data.toString());
    });
    serverProcess.stderr?.on('data', (data) => {
      startupLogs.push(data.toString());
    });

    // Wait for /healthz to respond on the configured host
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const res = await fetch(`http://${testHost}:${testPort}/healthz`);
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // not ready yet
      }
    }

    if (!ready) {
      throw new Error(`Server did not bind to ${testHost}:${testPort} within timeout. Logs:\n${startupLogs.join('')}`);
    }
  }, 45000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (!serverProcess) return resolve();
        // Without clearing this on normal exit, the pending timer keeps
        // the Vitest process alive until the 5s tail elapses.
        const killTimeout = setTimeout(() => {
          if (serverProcess && !serverProcess.killed) serverProcess.kill('SIGKILL');
          resolve();
        }, 5000);
        serverProcess.on('exit', () => {
          clearTimeout(killTimeout);
          resolve();
        });
      });
    }
    if (testDbPath && fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    if (isolatedCwd && fs.existsSync(isolatedCwd)) {
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it('responds on the configured host', async () => {
    const res = await fetch(`http://${testHost}:${testPort}/healthz`);
    expect(res.status).toBe(200);
  });

  it('uses the DSN env var, not an ambient dbhub.toml', () => {
    // Guards the isolated cwd above: if the server is ever spawned from the repo
    // root again, a developer's local dbhub.toml wins over DSN and this reports
    // the cause directly instead of an opaque startup timeout.
    expect(startupLogs.join('')).toContain('Configuration source: environment variable');
  });

  it('logs the actual bound address at startup', () => {
    const allLogs = startupLogs.join('');
    expect(allLogs).toContain(`${testHost}:${testPort}`);
  });
});
