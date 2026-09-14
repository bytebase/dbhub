import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { PostgresConnector } from "../postgres/index.js";

// A loopback PostgreSQL protocol peer: real pg sockets and password handling,
// no AWS access, real database, or SQL execution. Only auth/empty query responses.
function message(type: string, body: Buffer) {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
}
const ready = message("Z", Buffer.from("I"));
const sockets = new Set<Socket>();
const peers = new Map<string, Socket>();
const connectors: PostgresConnector[] = [];
const server = createServer(socket => {
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
        socket.write(Buffer.concat([message("C", Buffer.from("SELECT 0\0")), ready]));
      } else if (packet[0] === 88) { // terminate
        socket.end();
      }
    }
  });
});

afterEach(async () => {
  await Promise.all(connectors.splice(0).map(connector => connector.disconnect()));
  for (const socket of sockets) socket.destroy();
  peers.clear();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.restoreAllMocks();
});

it("recovers on demand after idle session expiry and failed auth, independently per source", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const passwords = [vi.fn().mockResolvedValue("short-token"), vi.fn().mockResolvedValue("long-token")];
  for (const [i, name] of ["short", "long"].entries()) {
    const connector = new PostgresConnector();
    connectors.push(connector);
    await connector.connect(`postgres://user@127.0.0.1:${port}/${name}?sslmode=disable`, undefined, {
      password: passwords[i], connectionTimeoutSeconds: i + 1,
    });
  }
  expect(passwords.map(password => password.mock.calls.length)).toEqual([1, 1]);

  // Server-side idle expiry is independent of IAM expiry. pg must remove this
  // idle client without an unhandled pool error or disturbing the other source.
  peers.get("short")!.end(message("E", Buffer.from("SFATAL\0C57P05\0Mterminating connection due to idle-session timeout\0\0")));
  await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining("idle connection error"), expect.stringContaining("idle-session timeout")));
  expect(passwords.map(password => password.mock.calls.length)).toEqual([1, 1]);

  passwords[0].mockRejectedValueOnce(new Error("SSO session expired"));
  await expect(connectors[0].getSchemas()).rejects.toThrow("SSO session expired");
  await expect(connectors[0].getSchemas()).resolves.toEqual([]);
  await expect(connectors[1].getSchemas()).resolves.toEqual([]);
  expect(passwords.map(password => password.mock.calls.length)).toEqual([3, 1]);
});
