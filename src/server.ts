import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { ConnectorManager } from "./connectors/manager.js";
import { ConnectorRegistry } from "./connectors/interface.js";
import { resolveTransport, resolvePort, resolveSourceConfigs, isDemoMode } from "./config/env.js";
import { registerTools } from "./tools/index.js";
import { listSources, getSource } from "./api/sources.js";
import { listRequests } from "./api/requests.js";
import { generateStartupTable, buildSourceDisplayInfo } from "./utils/startup-table.js";
import { getToolsForSource } from "./utils/tool-metadata.js";

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load package.json to get version
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

// Server info
export const SERVER_NAME = "DBHub MCP Server";
export const SERVER_VERSION = packageJson.version;

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

    // Create MCP server factory function for HTTP transport
    // Note: This must be created AFTER ConnectorManager is initialized
    const createServer = () => {
      const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });

      // Register tools (both built-in and custom)
      // All tools are validated and managed by the ToolRegistry
      registerTools(server);

      return server;
    };

    // Resolve transport type (for MCP server)
    const transportData = resolveTransport();

    // Resolve port for HTTP server (only needed for http transport)
    const port = transportData.type === "http" ? resolvePort().port : null;

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

    // Set up transport-specific server
    if (transportData.type === "http") {
      // HTTP transport: Start Express server with MCP endpoint and workbench
      const app = express();

      // Enable JSON parsing
      app.use(express.json());

      // Handle CORS and security headers
      app.use((req, res, next) => {
        // Validate Origin header to prevent DNS rebinding attacks
        const origin = req.headers.origin;
        if (origin && !origin.startsWith('http://localhost') && !origin.startsWith('https://localhost')) {
          return res.status(403).json({ error: 'Forbidden origin' });
        }

        res.header('Access-Control-Allow-Origin', origin || 'http://localhost');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
        res.header('Access-Control-Allow-Credentials', 'true');

        if (req.method === 'OPTIONS') {
          return res.sendStatus(200);
        }
        next();
      });

      // Serve static frontend files
      const frontendPath = path.join(__dirname, "public");
      app.use(express.static(frontendPath));

      // Health check endpoint
      app.get("/healthz", (req, res) => {
        res.status(200).send("OK");
      });

      // Data sources API endpoints
      app.get("/api/sources", listSources);
      app.get("/api/sources/:sourceId", getSource);
      app.get("/api/requests", listRequests);

      // Main endpoint for streamable HTTP transport
      // SSE streaming (GET requests) is not supported in stateless mode
      // Return 405 Method Not Allowed for GET requests to indicate this
      app.get("/mcp", (req, res) => {
        res.status(405).json({
          error: 'Method Not Allowed',
          message: 'SSE streaming is not supported in stateless mode. Use POST requests with JSON responses.'
        });
      });

      app.post("/mcp", async (req, res) => {
        try {
          // In stateless mode, create a new instance of transport and server for each request
          // to ensure complete isolation. A single instance would cause request ID collisions
          // when multiple clients connect concurrently.
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Disable session management for stateless mode
            enableJsonResponse: true // Use JSON responses (SSE not supported in stateless mode)
          });
          const server = createServer();

          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (error) {
          console.error("Error handling request:", error);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
          }
        }
      });

      // SPA fallback - serve index.html for all non-API routes (production only)
      // In development, the frontend is served by Vite dev server
      if (process.env.NODE_ENV !== 'development') {
        app.get("*", (req, res) => {
          res.sendFile(path.join(frontendPath, "index.html"));
        });
      }

      // Start the HTTP server
      app.listen(port, '0.0.0.0', () => {
        // In development mode, suggest using the Vite dev server for hot reloading
        if (process.env.NODE_ENV === 'development') {
          console.error('Development mode detected!');
          console.error('   Workbench dev server (with HMR): http://localhost:5173');
          console.error('   Backend API: http://localhost:8080');
          console.error('');
        } else {
          console.error(`Workbench at http://localhost:${port}/`);
        }
        console.error(`MCP server endpoint at http://localhost:${port}/mcp`);
      });
    } else {
      // STDIO transport: Pure MCP-over-stdio, no HTTP server
      const server = createServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error("MCP server running on stdio");

      // Listen for SIGINT to gracefully shut down
      process.on("SIGINT", async () => {
        console.error("Shutting down...");
        await transport.close();
        process.exit(0);
      });
    }
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
}
