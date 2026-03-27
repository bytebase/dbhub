#!/usr/bin/env node

import { main } from "./server.js";
import { isDriverNotInstalled } from "./utils/module-loader.js";

// Dynamically import connector modules so missing driver packages
// (e.g. when only one database type is needed) don't crash the server.
// Each load function uses a string literal so the bundler can resolve it.
const connectorModules = [
  { load: () => import("./connectors/postgres/index.js"), name: "PostgreSQL", driver: "pg" },
  { load: () => import("./connectors/sqlserver/index.js"), name: "SQL Server", driver: "mssql" },
  { load: () => import("./connectors/sqlite/index.js"), name: "SQLite", driver: "better-sqlite3" },
  { load: () => import("./connectors/mysql/index.js"), name: "MySQL", driver: "mysql2" },
  { load: () => import("./connectors/mariadb/index.js"), name: "MariaDB", driver: "mariadb" },
];

export async function loadConnectors(): Promise<void> {
  await Promise.all(
    connectorModules.map(async ({ load, name, driver }) => {
      try {
        await load();
      } catch (err) {
        if (isDriverNotInstalled(err, driver)) {
          console.error(
            `Skipping ${name} connector: driver package "${driver}" not installed.`
          );
        } else {
          throw err;
        }
      }
    })
  );
}

loadConnectors()
  .then(() => main())
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
