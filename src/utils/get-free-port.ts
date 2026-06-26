import { createServer } from 'net';

/**
 * Find an available TCP port on 127.0.0.1 by binding to port 0.
 */
export function getFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();

    server.on('error', reject);

    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a free local port'));
        return;
      }

      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}
