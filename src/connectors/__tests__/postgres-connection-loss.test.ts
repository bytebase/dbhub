import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresConnector } from "../postgres/index.js";
import type { ConnectorConfig } from "../interface.js";

// A loopback PostgreSQL protocol peer: real pg sockets and password handling,
// no AWS access, real database, or SQL execution. It asks every client for a
// cleartext password, answers queries with an empty result, and loses the
// connection on demand: while a query is in flight (the SQL asks for it), the
// way pg_terminate_backend, a failover or a proxy does, or while the client
// sits idle in the pool (the test ends its socket, found in `peers`).
function message(type: string, body: Buffer) {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
}
const ready = message("Z", Buffer.from("I"));
const sockets = new Set<Socket>();
/** The latest socket opened for each database name. */
const peers = new Map<string, Socket>();
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
        const params = packet.subarray(8).toString().split("\0");
        peers.set(params[params.indexOf("database") + 1], socket);
        startup = false;
        socket.write(message("R", Buffer.from([0, 0, 0, 3]))); // cleartext password request
      } else if (packet[0] === 112) { // password
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

const connectors: PostgresConnector[] = [];
let port: number;

async function connect(database: string, config?: ConnectorConfig): Promise<PostgresConnector> {
  const connector = new PostgresConnector();
  connectors.push(connector);
  // A source with a password callback (IAM) has no password in its DSN
  const auth = config?.password ? "user" : "user:pw";
  await connector.connect(`postgres://${auth}@127.0.0.1:${port}/${database}?sslmode=disable`, undefined, config);
  return connector;
}

beforeEach(async () => {
  connections = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await Promise.all(connectors.splice(0).map(connector => connector.disconnect()));
  for (const socket of sockets) socket.destroy();
  peers.clear();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
});

// pg emits 'error' on the Client for an unexpected disconnect; while the client
// is checked out of the pool nothing but the connector is listening, so without
// a listener the whole process exits (#479).
describe("connection lost while a query is in flight", () => {
  let connector: PostgresConnector;

  beforeEach(async () => {
    connector = await connect("db");
    expect(connections).toBe(1);
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
});

describe("connection lost while idle, with a password callback (IAM)", () => {
  it("recovers on demand after idle session expiry and failed auth, independently per source", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const passwords = [vi.fn().mockResolvedValue("short-token"), vi.fn().mockResolvedValue("long-token")];
    const short = await connect("short", { password: passwords[0], connectionTimeoutSeconds: 1 });
    const long = await connect("long", { password: passwords[1], connectionTimeoutSeconds: 2 });
    expect(passwords.map(password => password.mock.calls.length)).toEqual([1, 1]);

    // Server-side idle expiry is independent of IAM expiry. pg must remove this
    // idle client without an unhandled pool error or disturbing the other source.
    peers.get("short")!.end(message("E", Buffer.from("SFATAL\0C57P05\0Mterminating connection due to idle-session timeout\0\0")));
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
      expect.any(String), expect.stringContaining("idle-session timeout")));
    expect(passwords.map(password => password.mock.calls.length)).toEqual([1, 1]);

    passwords[0].mockRejectedValueOnce(new Error("SSO session expired"));
    await expect(short.getSchemas()).rejects.toThrow("SSO session expired");
    await expect(short.getSchemas()).resolves.toEqual([]);
    await expect(long.getSchemas()).resolves.toEqual([]);
    expect(passwords.map(password => password.mock.calls.length)).toEqual([3, 1]);
  });
});
