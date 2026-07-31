import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import express from "express";
import http from "http";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { ConnectorManager } from "./connectors/manager.js";
import { ConnectorRegistry } from "./connectors/interface.js";
import { resolveTransport, resolvePort, resolveHost, resolveAllowedHosts, resolveAuthTokens, resolveSourceConfigs, isDemoMode } from "./config/env.js";
import { registerTools } from "./tools/index.js";
import { listSources, getSource } from "./api/sources.js";
import { listRequests } from "./api/requests.js";
import { generateStartupTable, buildSourceDisplayInfo } from "./utils/startup-table.js";
import { getToolsForSource } from "./utils/tool-metadata.js";
import { startConfigWatcher } from "./utils/config-watcher.js";
import { validateOrigin, buildAllowedHosts, getSelfHosts, ALLOW_ANY_HOST } from "./utils/cross-origin.js";
import { validateAuthToken } from "./utils/auth-token.js";

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load package.json to get version
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

// Server info
export const SERVER_NAME = "DBHub MCP Server";
export const SERVER_VERSION = packageJson.version;

// How long 2026-07-28 clients may cache tools/list without refetching
// (2025-era responses never carry cache fields). The tool list only changes
// on a TOML config hot reload, so this bounds how stale a modern client's
// cached tool list can be after a reload.
const TOOLS_LIST_CACHE_TTL_MS = 300_000;

/** Per-surface error logger for the MCP serving entries. */
const logMcpError = (scope: string) => (error: Error) =>
  console.error(`MCP ${scope} error:`, error);

/**
 * Generate ASCII art banner with version information
 */
export function generateBanner(version: string, modes: string[] = []): string {
  // Create a mode string that includes all active modes
  const modeText = modes.length > 0 ? ` [${modes.join(' | ')}]` : '';

  return `
 _____  ____  _   _       _     
|  __ \\|  _ \\| | | |     | |    
| |  | | |_) | |_| |_   _| |__  
| |  | |  _ <|  _  | | | | '_ \\ 
| |__| | |_) | | | | |_| | |_) |
|_____/|____/|_| |_|\\__,_|_.__/ 
                                
v${version}${modeText} - Minimal Database MCP Server
`;
}

/**
 * Initialize and start the DBHub server
 */
export async function main(): Promise<void> {
  try {
    // Resolve source configurations from TOML or fallback to single DSN
    const sourceConfigsData = await resolveSourceConfigs();

    if (!sourceConfigsData) {
      const samples = ConnectorRegistry.getAllSampleDSNs();
      const sampleFormats = Object.entries(samples)
        .map(([id, dsn]) => `  - ${id}: ${dsn}`)
        .join("\n");

      console.error(`
ERROR: Database connection configuration is required.
Please provide configuration in one of these ways (in order of priority):

1. Use demo mode: --demo (uses in-memory SQLite with sample employee database)
2. TOML config file: --config=path/to/dbhub.toml or ./dbhub.toml
3. Command line argument: --dsn="your-connection-string"
4. Environment variable: export DSN="your-connection-string"
5. .env file: DSN=your-connection-string

Example DSN formats:
${sampleFormats}

Example TOML config (dbhub.toml):
  [[sources]]
  id = "my_db"
  dsn = "postgres://user:pass@localhost:5432/dbname"

See documentation for more details on configuring database connections.
`);
      process.exit(1);
    }

    // Create connector manager and connect to database(s)
    const connectorManager = new ConnectorManager();
    const sources = sourceConfigsData.sources;

    console.error(`Configuration source: ${sourceConfigsData.source}`);

    // Connect to database(s) - works uniformly for all modes (demo, single DSN, multi-source TOML)
    await connectorManager.connectWithSources(sources);

    // Initialize tool registry (manages both built-in and custom tools)
    // This must happen AFTER ConnectorManager is initialized so source validation works
    const { initializeToolRegistry } = await import("./tools/registry.js");
    initializeToolRegistry({
      sources: sourceConfigsData.sources,
      tools: sourceConfigsData.tools,
    });
    console.error("Tool registry initialized");

    // Start watching TOML config file for hot reload (only when using TOML config).
    // In STDIO mode, tool list is registered once — hot reload updates connections and
    // tool registry, but STDIO clients won't see added/removed tools without restart.
    // HTTP transport creates a new server per request, so tool changes apply immediately
    // (2026-07-28 clients may serve a cached tool list for up to TOOLS_LIST_CACHE_TTL_MS).
    const stopConfigWatcher = startConfigWatcher({
      connectorManager,
      initialTools: sourceConfigsData.tools,
    });

    // Create MCP server factory function (used per HTTP request and per stdio connection)
    // Note: This must be created AFTER ConnectorManager is initialized
    const createServer = () => {
      const server = new McpServer(
        {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        {
          // `private` keeps caching client-side (no shared/proxy caches).
          cacheHints: {
            "tools/list": { ttlMs: TOOLS_LIST_CACHE_TTL_MS, cacheScope: "private" },
          },
        }
      );

      // Register tools (both built-in and custom)
      // All tools are validated and managed by the ToolRegistry
      registerTools(server);

      return server;
    };

    // Resolve transport type (for MCP server)
    const transportData = resolveTransport();

    // Resolve port and host for HTTP server (only needed for http transport)
    const port = transportData.type === "http" ? resolvePort().port : null;
    const host = transportData.type === "http" ? resolveHost().host : null;

    // DNS-rebinding allow-list for the HTTP transport: loopback is always
    // permitted; a wildcard bind also auto-allows this machine's hostname/IPs so
    // network clients work without extra config, and operators add any other
    // served hostnames via --allowed-hosts / DBHUB_ALLOWED_HOSTS ("*" disables).
    const allowedHosts =
      transportData.type === "http"
        ? buildAllowedHosts(resolveAllowedHosts().hosts, host ?? undefined, getSelfHosts())
        : new Set<string>();

    // Bearer token auth for the HTTP transport (issue #66). Configuring a
    // token is itself the opt-in — an empty list (the default) leaves
    // today's unauthenticated behavior unchanged. Only meaningful for http,
    // but resolving it is cheap enough not to gate on transport type.
    const { tokens: authTokens, source: authTokenSource } = resolveAuthTokens();

    // Print ASCII art banner with version and slogan
    // Collect active modes
    const activeModes: string[] = [];
    const modeDescriptions: string[] = [];
    const isDemo = isDemoMode();

    if (isDemo) {
      activeModes.push("DEMO");
      modeDescriptions.push("using sample employee database");
    }

    // Output mode information
    if (activeModes.length > 0) {
      console.error(`Running in ${activeModes.join(' and ')} mode - ${modeDescriptions.join(', ')}`);
    }

    console.error(generateBanner(SERVER_VERSION, activeModes));

    // Print sources and tools table
    const sourceDisplayInfos = buildSourceDisplayInfo(
      sources,
      (sourceId) => getToolsForSource(sourceId).map((t) => t.readonly ? `🔒 ${t.name}` : t.name),
      isDemo
    );
    console.error(generateStartupTable(sourceDisplayInfos));

    // Clean up config watcher when the process is exiting (covers both transports)
    process.on("exit", () => { stopConfigWatcher?.(); });

    // Set up transport-specific server
    if (transportData.type === "http") {
      // HTTP transport: Start Express server with MCP endpoint and workbench
      const app = express();

      // Enable JSON parsing
      app.use(express.json());

      // DNS-rebinding guard: validate the Host header against an explicit
      // allow-list (loopback + the bind host + any --allowed-hosts) on every
      // request, and validate Origin when present. A rebound attacker hostname
      // is not on the list and is rejected even though Origin and Host agree —
      // closing GHSA-fm8p-53ww-hf6w / GHSA-fp99-xwp4-hv8q / GHSA-qvg2-3c48-77mx.
      // Non-browser MCP clients targeting an allowed host are unaffected.
      app.use((req, res, next) => {
        const origin = req.headers.origin;
        const result = validateOrigin(origin, req.headers.host, allowedHosts);
        if (!result.ok) {
          return res.status(result.status).json({
            error: result.status === 400 ? 'Bad Request' : 'Forbidden',
            message: result.message,
          });
        }

        // CORS headers — only reflect validated origins. Beyond the legacy
        // Mcp-Session-Id, allow the 2026-07-28 standard headers (SEP-2243)
        // that clients send for header-based routing: MCP-Protocol-Version,
        // Mcp-Method, and Mcp-Name. (Mcp-Param-* headers are dynamically
        // named and cannot be statically allow-listed — browser clients skip
        // mirroring them for exactly this reason.)
        res.header('Access-Control-Allow-Origin', origin || 'http://localhost');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name');
        res.header('Access-Control-Allow-Credentials', 'true');

        if (req.method === 'OPTIONS') {
          return res.sendStatus(200);
        }
        next();
      });

      // Health check endpoint. Registered before the auth middleware below so
      // it never requires a token — uptime monitors don't have one — without
      // the auth middleware needing to know about specific unauthenticated
      // routes; it responds directly and never calls next().
      app.get("/healthz", (req, res) => {
        res.status(200).send("OK");
      });

      // Bearer token auth (issue #66): rejects requests missing a valid
      // `Authorization: Bearer <token>` header when --auth-token/DBHUB_AUTH_TOKEN
      // is configured; a no-op when it isn't.
      app.use((req, res, next) => {
        const result = validateAuthToken(req.headers.authorization, authTokens);
        if (!result.ok) {
          res.header('WWW-Authenticate', 'Bearer');
          return res.status(result.status).json({ error: 'Unauthorized', message: result.message });
        }
        next();
      });

      // Serve static frontend files
      const frontendPath = path.join(__dirname, "public");
      app.use(express.static(frontendPath));

      // Data sources API endpoints
      app.get("/api/sources", listSources);
      app.get("/api/sources/:sourceId", getSource);
      app.get("/api/requests", listRequests);

      // Main MCP endpoint. createMcpHandler serves both protocol eras from
      // the same factory: 2026-07-28 requests natively (stateless by design —
      // a fresh server instance per request, no Mcp-Session-Id), and 2025-era
      // clients through the default `legacy: 'stateless'` fallback, which is
      // the same per-request idiom DBHub hand-wired before. It also validates
      // the 2026-07-28 standard headers (Mcp-Method / Mcp-Name) against the
      // body on the modern path.
      const mcpHandler = createMcpHandler(createServer, { onerror: logMcpError("handler") });
      const mcpNodeHandler = toNodeHandler(mcpHandler, { onerror: logMcpError("adapter") });

      // express.json() has already consumed the request stream, so hand the
      // pre-parsed body to the adapter explicitly.
      app.all("/mcp", (req, res) => {
        void mcpNodeHandler(req, res, req.body);
      });

      // SPA fallback - serve index.html for all non-API routes (production only)
      // In development, the frontend is served by Vite dev server
      if (process.env.NODE_ENV !== 'development') {
        app.get("*", (req, res) => {
          res.sendFile(path.join(frontendPath, "index.html"));
        });
      }

      // Start the HTTP server. Create explicitly so the `error` listener is
      // attached before listen() — otherwise synchronous bind failures
      // (EADDRINUSE, EACCES on privileged ports) can fire before the listener
      // is registered. Matches the pattern used in utils/ssh-tunnel.ts.
      const httpServer = http.createServer(app);

      httpServer.on('error', (err) => {
        const displayHost = host!.includes(':') ? `[${host!}]` : host!;
        console.error(`Failed to bind HTTP server to ${displayHost}:${port}: ${err.message}`);
        process.exit(1);
      });

      httpServer.listen(port!, host!, () => {
        const address = httpServer.address();
        const boundHost = typeof address === 'object' && address ? address.address : host!;
        const boundPort = typeof address === 'object' && address ? address.port : port!;
        const displayHost = boundHost.includes(':') ? `[${boundHost}]` : boundHost;
        // Wildcard binds (0.0.0.0 / ::) are not routable; use localhost for user URLs.
        const userHost = (boundHost === '0.0.0.0' || boundHost === '::') ? 'localhost' : displayHost;

        console.error(`HTTP server listening on ${displayHost}:${boundPort}`);

        // Surface the DNS-rebinding allow-list so operators know which Host
        // values are accepted (and how to widen it for network deployments).
        if (allowedHosts.has(ALLOW_ANY_HOST)) {
          console.error('Allowed hosts: * (DNS-rebinding protection DISABLED — ensure DBHub is fronted by your own auth/proxy)');
        } else {
          console.error(`Allowed hosts: ${[...allowedHosts].join(', ')} (set --allowed-hosts to serve other hostnames)`);
        }

        // Surface whether bearer token auth is enforced (issue #66).
        if (authTokens.length > 0) {
          console.error(`Auth: bearer token required (${authTokens.length} token(s) configured via ${authTokenSource})`);
        } else {
          console.error('Auth: disabled (set --auth-token or DBHUB_AUTH_TOKEN to require a bearer token)');
        }

        // In development mode, suggest using the Vite dev server for hot reloading.
        // Vite serves from localhost; use the same hostname for the backend hint so
        // cross-origin calls from Vite satisfy the DNS-rebinding middleware check.
        if (process.env.NODE_ENV === 'development') {
          console.error('Development mode detected!');
          console.error('   Workbench dev server (with HMR): http://localhost:5173');
          console.error(`   Backend API: http://localhost:${boundPort}`);
          console.error('');
        } else {
          console.error(`Workbench at http://${userHost}:${boundPort}/`);
        }
        console.error(`MCP server endpoint at http://${userHost}:${boundPort}/mcp`);
      });
    } else {
      // STDIO transport: Pure MCP-over-stdio, no HTTP server. serveStdio owns
      // the era decision per connection: a 2026-07-28 opening is served
      // natively, a 2025-era `initialize` pins a legacy-era instance from the
      // same factory — same behavior as the previous hand-wired transport.
      const stdioHandle = serveStdio(createServer, { onerror: logMcpError("stdio") });
      console.error("MCP server running on stdio");

      let isShuttingDown = false;
      const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.error("Shutting down...");
        await stdioHandle.close();
        await connectorManager.disconnect();
        process.exit(0);
      };

      // Listen for SIGINT/SIGTERM to gracefully shut down
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Exit when stdin closes (parent process terminated).
      // On Windows, SIGINT/SIGTERM are not reliably sent when the parent
      // process exits — detecting stdin EOF is the portable way to handle this.
      process.stdin.on("end", shutdown);
    }
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}
