#!/usr/bin/env node

import { main } from "./server.js";

// Dynamically import connector modules so missing driver packages
// (e.g. when only one database type is needed) don't crash the server.
const connectorModules = [
  { modulePath: "./connectors/postgres/index.js", name: "PostgreSQL" },
  { modulePath: "./connectors/sqlserver/index.js", name: "SQL Server" },
  { modulePath: "./connectors/sqlite/index.js", name: "SQLite" },
  { modulePath: "./connectors/mysql/index.js", name: "MySQL" },
  { modulePath: "./connectors/mariadb/index.js", name: "MariaDB" },
];

function isModuleNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
  );
}

async function loadConnectors(): Promise<void> {
  await Promise.all(
    connectorModules.map(async ({ modulePath, name }) => {
      try {
        await import(modulePath);
      } catch (err) {
        if (isModuleNotFound(err)) {
          console.error(
            `Skipping ${name} connector: driver package not installed.`
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
