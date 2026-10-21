import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PostgresConnector } from "../postgres/index.js";

// A loopback PostgreSQL protocol peer that ends the connection on demand while
// a query is in flight, the way pg_terminate_backend, a failover or a proxy
// does. pg emits 'error' on the Client for an unexpected disconnect; while the
// client is checked out of the pool nothing but the connector is listening, so
// without a listener the whole process exits (#479).
function message(type: string, body: Buffer) {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
}
const ready = message("Z", Buffer.from("I"));
const sockets = new Set<Socket>();
let connections = 0;
const server = createServer(socket => {
  connections++;
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  let startup = true;
  let buffer: Buffer = Buffer.alloc(0);
  socket.on("data", data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= (startup ? 4 : 5)) {
      const length = buffer.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
      if (buffer.length < length) return;
      const packet = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      if (startup) {
        startup = false;
        socket.write(Buffer.concat([message("R", Buffer.alloc(4)), ready]));
      } else if (packet[0] === 81) { // simple query
        const sql = packet.subarray(5, length - 1).toString();
        if (sql.includes("pg_terminate_backend")) {
          // FATAL, then the backend closes the socket.
          socket.end(message("E", Buffer.from("SFATAL\0C57P01\0Mterminating connection due to administrator command\0\0")));
        } else if (sql.includes("reset_socket")) {
          // No error message first: the TCP connection just goes away.
          socket.destroy();
        } else {
          socket.write(Buffer.concat([message("C", Buffer.from("SELECT 0\0")), ready]));
        }
      } else if (packet[0] === 88) { // terminate
        socket.end();
      }
    }
  });
});

let connector: PostgresConnector;

beforeEach(async () => {
  connections = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  connector = new PostgresConnector();
  await connector.connect(`postgres://user@127.0.0.1:${port}/db?sslmode=disable`);
  expect(connections).toBe(1);
});

afterEach(async () => {
  await connector.disconnect();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
});

async function expectRecovery(): Promise<void> {
  // Let the socket 'end'/'close' land while the process is still alive.
  await new Promise(resolve => setTimeout(resolve, 50));
  // The dropped client was discarded, not returned to the pool: the next
  // query opens a fresh connection instead of drawing the dead one.
  await expect(connector.executeSQL("SELECT 1", {})).resolves.toMatchObject({ resultSets: [{ rowCount: 0 }] });
  expect(connections).toBe(2);
}

it("survives the server ending the connection mid-batch (multi-statement)", async () => {
  await expect(connector.executeSQL("SELECT 1; SELECT pg_terminate_backend(pg_backend_pid())", {}))
    .rejects.toThrow("terminating connection due to administrator command");
  await expectRecovery();
});

it("survives the server ending the connection inside a READ ONLY transaction", async () => {
  await expect(connector.executeSQL("SELECT pg_terminate_backend(pg_backend_pid())", { readonly: true }))
    .rejects.toThrow("terminating connection due to administrator command");
  await expectRecovery();
});

it("survives the connection being reset without an error message", async () => {
  await expect(connector.executeSQL("SELECT reset_socket()", {}))
    .rejects.toThrow("Connection terminated unexpectedly");
  await expectRecovery();
});
