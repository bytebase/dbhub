import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { ConnectorManager } from "./connectors/manager.js";
import { ConnectorRegistry } from "./connectors/interface.js";
import { resolveMultiDSN, resolveTransport, resolvePort, isDemoMode, redactDSN, isReadOnlyMode, resolveId } from "./config/env.js";
import { getSqliteInMemorySetupSql } from "./config/demo-loader.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";
import { registerPrompts } from "./prompts/index.js";

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
                                
v${version}${modeText} - Universal Database MCP Server
`;
}

/**
 * Initialize and start the DBHub server
 */
export async function main(): Promise<void> {
  try {
    // Resolve ID from command line args (for Cursor multi-instance support)
    const idData = resolveId();
    const id = idData?.id;

    // Resolve DSNs from command line args, environment variables, or .env files
    const dsnData = resolveMultiDSN();

    if (!dsnData || dsnData.size === 0) {
      const samples = ConnectorRegistry.getAllSampleDSNs();
      const sampleFormats = Object.entries(samples)
        .map(([id, dsn]) => `  - ${id}: ${dsn}`)
        .join("\n");

      console.error(`
ERROR: Database connection string (DSN) is required.
Please provide the DSN in one of these ways (in order of priority):

1. Use demo mode: --demo (uses in-memory SQLite with sample employee database)
2. Command line argument: --dsn="your-connection-string"
3. Environment variable: export DSN="your-connection-string"
4. .env file: DSN=your-connection-string

For multiple databases:
1. Environment variables: DSN_dev, DSN_test, etc.
2. .env file: DSN_dev=your-connection-string, DSN_test=another-connection-string

Example formats:
${sampleFormats}

See documentation for more details on configuring database connections.
`);
      process.exit(1);
    }

    // Create MCP server factory function for HTTP transport
    const createServer = (databaseId?: string) => {
      const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });

      // Register resources, tools, and prompts with optional database ID
      registerResources(server, databaseId);
      registerTools(server, databaseId);
      registerPrompts(server);

      return server;
    };

    // Create server factory function (will be used for both STDIO and HTTP transports)

    // Create connector manager and connect to databases
    const connectorManager = new ConnectorManager();
    
    if (isDemoMode()) {
      // If in demo mode, load the employee database
      const initScript = getSqliteInMemorySetupSql();
      const databaseId = "default";
      const dsnInfo = dsnData.get(databaseId)!;
      await connectorManager.connectWithDSN(dsnInfo.dsn, databaseId, initScript);
    } else {
      // Connect to all databases
      for (const [databaseId, dsnInfo] of dsnData) {
        console.error(`Connecting to database '${databaseId}' with DSN: ${redactDSN(dsnInfo.dsn)}`);
        console.error(`DSN source: ${dsnInfo.source}`);
        await connectorManager.connectWithDSN(dsnInfo.dsn, databaseId);
      }
    }

    // Store the connector manager instance globally so it can be accessed by all endpoints
    (global as any).__dbhubConnectorManager = connectorManager;

    if (idData) {
      console.error(`ID: ${idData.id} (from ${idData.source})`);
    }

    // Resolve transport type
    const transportData = resolveTransport();
    console.error(`Using transport: ${transportData.type}`);
    console.error(`Transport source: ${transportData.source}`);

    // Print ASCII art banner with version and slogan
    const readonly = isReadOnlyMode();

    // Collect active modes
    const activeModes: string[] = [];
    const modeDescriptions: string[] = [];

    // Check if any database is in demo mode
    const hasDemoMode = Array.from(dsnData.values()).some(dsnInfo => dsnInfo.isDemo);
    if (hasDemoMode) {
      activeModes.push("DEMO");
      modeDescriptions.push("using sample employee database");
    }

    if (readonly) {
      activeModes.push("READ-ONLY");
      modeDescriptions.push("only read only queries allowed");
    }

    // Output mode information
    if (activeModes.length > 0) {
      console.error(`Running in ${activeModes.join(' and ')} mode - ${modeDescriptions.join(', ')}`);
    }
    
    console.error(generateBanner(SERVER_VERSION, activeModes));

    // Set up transport based on type
    if (transportData.type === "http") {
      // Set up Express server for Streamable HTTP transport
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

      // Root endpoint for client connection checks
      app.get("/", (req, res) => {
        res.status(200).send();
      });

      // Health check endpoint
      app.get("/healthz", (req, res) => {
        res.status(200).send("OK");
      });


      // Unified endpoints for all databases
      for (const [databaseId] of dsnData) {
        const path = databaseId === "default" ? "/message" : `/message/${databaseId}`;
        app.post(path, async (req, res) => {
          try {
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined,
              enableJsonResponse: false
            });
            const server = createServer(databaseId);

            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
          } catch (error) {
            console.error(`Error handling request for database '${databaseId}':`, error);
            if (!res.headersSent) {
              res.status(500).json({ error: 'Internal server error' });
            }
          }
        });
      }


      // Start the HTTP server
      const portData = resolvePort();
      const port = portData.port;
      console.error(`Port source: ${portData.source}`);
      app.listen(port, '0.0.0.0', () => {
        console.error(`DBHub server listening at http://0.0.0.0:${port}`);
        console.error(`Available database endpoints:`);
        for (const [databaseId] of dsnData) {
          const path = databaseId === "default" ? "/message" : `/message/${databaseId}`;
          console.error(`  - ${databaseId}: http://0.0.0.0:${port}${path}`);
        }
      });
    } else {
      // Set up STDIO transport
      const server = createServer();
      const transport = new StdioServerTransport();
      console.error("Starting with STDIO transport");

      // Show available databases for STDIO mode
      if (dsnData.size > 1) {
        console.error("Available databases:");
        for (const [databaseId, dsnInfo] of dsnData) {
          console.error(`  - ${databaseId}: ${redactDSN(dsnInfo.dsn)}`);
        }
        console.error("Note: STDIO mode uses the default database. Use HTTP transport for multi-database access.");
      }

      await server.connect(transport);

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
