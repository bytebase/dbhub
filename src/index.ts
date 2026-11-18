#!/usr/bin/env node

import { main } from "./server.js";
import { loadConnectors } from "./utils/module-loader.js";

// Each load function uses a string literal so the bundler can resolve it.
const connectorModules = [
  { load: () => import("./connectors/postgres/index.js"), name: "PostgreSQL", driver: "pg", schemes: ["postgres", "postgresql"] },
  { load: () => import("./connectors/sqlserver/index.js"), name: "SQL Server", driver: "mssql", schemes: ["sqlserver"] },
  { load: () => import("./connectors/sqlite/index.js"), name: "SQLite", driver: "node:sqlite", schemes: ["sqlite"] },
  { load: () => import("./connectors/mysql/index.js"), name: "MySQL", driver: "mysql2", schemes: ["mysql"] },
  { load: () => import("./connectors/mariadb/index.js"), name: "MariaDB", driver: "mariadb", schemes: ["mariadb"] },
  { load: () => import("./connectors/oracle/index.js"), name: "Oracle", driver: "oracledb", schemes: ["oracle"] },
  { load: () => import("./connectors/clickhouse/index.js"), name: "ClickHouse", driver: "@clickhouse/client", schemes: ["clickhouse"] },
];

loadConnectors(connectorModules)
  .then(() => main())
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
