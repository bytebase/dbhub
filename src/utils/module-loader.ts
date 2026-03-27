// Matches the package name from Node.js ERR_MODULE_NOT_FOUND messages:
//   Cannot find package 'pg' imported from ...
//   Cannot find module 'mysql2/promise' ...
const MISSING_MODULE_RE = /Cannot find (?:package|module) '([^']+)'/;

/**
 * Check if an error is an ERR_MODULE_NOT_FOUND for a specific driver package.
 * Matches the exact package name or a subpath import (e.g. "mysql2/promise"
 * matches driver "mysql2"), but not unrelated packages that happen to contain
 * the driver name as a substring (e.g. "pg-connection-string" does not match "pg").
 */
export function isDriverNotInstalled(err: unknown, driver: string): boolean {
  if (
    !(err instanceof Error) ||
    !("code" in err) ||
    (err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND"
  ) {
    return false;
  }

  const match = err.message.match(MISSING_MODULE_RE);
  if (!match) {
    return false;
  }

  const missingSpecifier = match[1];
  return (
    missingSpecifier === driver ||
    missingSpecifier.startsWith(`${driver}/`)
  );
}

export interface ConnectorModule {
  load: () => Promise<unknown>;
  name: string;
  driver: string;
}

/**
 * Load connector modules, gracefully skipping any whose driver package
 * is not installed.
 */
export async function loadConnectors(
  connectorModules: ConnectorModule[]
): Promise<void> {
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
