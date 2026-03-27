#!/usr/bin/env node

import { main } from "./server.js";
import { loadConnectors } from "./utils/module-loader.js";

// Each load function uses a string literal so the bundler can resolve it.
const connectorModules = [
  { load: () => import("./connectors/postgres/index.js"), name: "PostgreSQL", driver: "pg" },
  { load: () => import("./connectors/sqlserver/index.js"), name: "SQL Server", driver: "mssql" },
  { load: () => import("./connectors/sqlite/index.js"), name: "SQLite", driver: "better-sqlite3" },
  { load: () => import("./connectors/mysql/index.js"), name: "MySQL", driver: "mysql2" },
  { load: () => import("./connectors/mariadb/index.js"), name: "MariaDB", driver: "mariadb" },
];

loadConnectors(connectorModules)
  .then(() => main())
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
