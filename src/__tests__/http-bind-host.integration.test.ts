import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnHttpServer, type SpawnedHttpServer } from './spawn-http-server.js';

describe('HTTP bind host integration', () => {
  const testHost = '127.0.0.1';
  let server: SpawnedHttpServer;

  beforeAll(async () => {
    server = await spawnHttpServer(testHost);
  }, 45000);

  afterAll(async () => {
    await server?.stop();
  });

  it('responds on the configured host', async () => {
    const res = await fetch(`http://${testHost}:${server.port}/healthz`);
    expect(res.status).toBe(200);
  });

  it('logs the actual bound address at startup', () => {
    expect(server.logs.join('')).toContain(`HTTP server listening on ${testHost}:${server.port}`);
  });
});
