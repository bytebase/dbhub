import express, { type RequestHandler } from "express";
import type { Server } from "http";

/**
 * Serve the given GET routes from an Express app on an ephemeral port (to
 * avoid conflicts between test files).
 */
export async function startApiServer(
  routes: Record<string, RequestHandler>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  for (const [path, handler] of Object.entries(routes)) {
    app.get(path, handler);
  }

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not report a bound port");
  }

  return {
    baseUrl: `http://localhost:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
