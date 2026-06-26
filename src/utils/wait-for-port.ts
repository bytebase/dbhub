import { connect } from 'net';

export interface WaitForPortOptions {
  host?: string;
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Poll until a TCP port accepts connections or timeout/abort.
 */
export function waitForPort(port: number, options: WaitForPortOptions = {}): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const signal = options.signal;
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new Error(`Timed out waiting for ${host}:${port} to accept connections`));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    const tryConnect = () => {
      if (signal?.aborted) {
        return;
      }

      if (Date.now() >= deadline) {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Timed out waiting for ${host}:${port} to accept connections`));
        return;
      }

      const socket = connect({ host, port });
      socket.setTimeout(1_000);

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.once('connect', () => {
        cleanup();
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });

      socket.once('error', () => {
        cleanup();
        setTimeout(tryConnect, intervalMs);
      });

      socket.once('timeout', () => {
        cleanup();
        setTimeout(tryConnect, intervalMs);
      });
    };

    tryConnect();
  });
}
