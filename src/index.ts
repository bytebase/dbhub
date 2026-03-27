#!/usr/bin/env node

import { main } from "./server.js";

// Dynamically import connector modules so missing driver packages
// (e.g. when only one database type is needed) don't crash the server.
const connectorModules = [
  { modulePath: "./connectors/postgres/index.js", name: "PostgreSQL", driver: "pg" },
  { modulePath: "./connectors/sqlserver/index.js", name: "SQL Server", driver: "mssql" },
  { modulePath: "./connectors/sqlite/index.js", name: "SQLite", driver: "better-sqlite3" },
  { modulePath: "./connectors/mysql/index.js", name: "MySQL", driver: "mysql2" },
  { modulePath: "./connectors/mariadb/index.js", name: "MariaDB", driver: "mariadb" },
];

import { isDriverNotInstalled } from "./utils/module-loader.js";

export async function loadConnectors(): Promise<void> {
  await Promise.all(
    connectorModules.map(async ({ modulePath, name, driver }) => {
      try {
        await import(modulePath);
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
