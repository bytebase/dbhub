#!/usr/bin/env node

// Import connector modules to register them
import "./connectors/postgres/index.js"; // Register PostgreSQL connector
import "./connectors/sqlserver/index.js"; // Register SQL Server connector
import "./connectors/sqlite/index.js"; // SQLite connector
import "./connectors/mysql/index.js"; // MySQL connector
import "./connectors/mariadb/index.js"; // MariaDB connector
import "./connectors/redis/index.js"; // Redis connector
import "./connectors/elasticsearch/index.js"; // Elasticsearch connector

// Import main function from server.ts
import { main } from "./server.js";

/**
 * Entry point for the DBHub MCP Server
 * Handles top-level exceptions and starts the server
 */
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
