import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import { ConnectorManager } from "./connectors/manager.js";
import { ConnectorRegistry } from "./connectors/interface.js";
import { resolveDSN, resolveTransport, resolvePort, isDemoMode, redactDSN, isReadOnlyMode, resolveId } from "./config/env.js";
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

    // Resolve DSN from command line args, environment variables, or .env files
    const dsnData = resolveDSN();

    if (!dsnData) {
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

Example formats:
${sampleFormats}

See documentation for more details on configuring database connections.
`);
      process.exit(1);
    }

    // Create MCP server factory function for HTTP transport
    const createServer = () => {
      const server = new McpServer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
      });

      // Register resources, tools, and prompts
      registerResources(server);
      registerTools(server, id);
      registerPrompts(server);

      return server;
    };

    // Create server factory function (will be used for both STDIO and HTTP transports)

    // Create connector manager and connect to database
    const connectorManager = new ConnectorManager();
    console.error(`Connecting with DSN: ${redactDSN(dsnData.dsn)}`);
    console.error(`DSN source: ${dsnData.source}`);
    if (idData) {
      console.error(`ID: ${idData.id} (from ${idData.source})`);
    }

    // If in demo mode, load the employee database
    if (dsnData.isDemo) {
      const initScript = getSqliteInMemorySetupSql();
      await connectorManager.connectWithDSN(dsnData.dsn, initScript);
    } else {
      await connectorManager.connectWithDSN(dsnData.dsn);
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
    
    if (dsnData.isDemo) {
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

      // Main endpoint for streamable HTTP transport
      app.post("/message", async (req, res) => {
        try {
          // In stateless mode, create a new instance of transport and server for each request
          // to ensure complete isolation. A single instance would cause request ID collisions
          // when multiple clients connect concurrently.
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Disable session management for stateless mode
            enableJsonResponse: false // Use SSE streaming
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


      // Start the HTTP server
      const portData = resolvePort();
      const port = portData.port;
      console.error(`Port source: ${portData.source}`);
      app.listen(port, '0.0.0.0', () => {
        console.error(`DBHub server listening at http://0.0.0.0:${port}`);
        console.error(`Connect to MCP server at http://0.0.0.0:${port}/message`);
      });
    } else {
      // Set up STDIO transport
      const server = createServer();
      const transport = new StdioServerTransport();
      console.error("Starting with STDIO transport");
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
