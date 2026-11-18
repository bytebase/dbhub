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

/**
 * Check if an error is any kind of missing module error (ESM or CJS).
 * This catches both direct driver failures and transitive dependency failures,
 * e.g. when "mssql" is installed but its transitive dep "@azure/core-client" is not.
 */
export function isModuleNotFound(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

export interface ConnectorModule {
  load: () => Promise<unknown>;
  name: string;
  driver: string;
  /** DSN schemes this connector handles (e.g. ["postgres", "postgresql"]). */
  schemes?: string[];
}

interface SkippedConnector {
  name: string;
  /** The package that could not be resolved: the driver itself or one of its dependencies. */
  missing: string;
  schemes: string[];
}

// Connectors skipped by loadConnectors, kept so a source that needs one can fail
// with the actual cause instead of a bare "No connector found".
const skippedConnectors: SkippedConnector[] = [];

/**
 * Return the npx cache directory (".../_npx") when the given script path lives
 * inside one, or null otherwise.
 */
export function getNpxCacheDir(scriptPath: string | undefined): string | null {
  if (!scriptPath) {
    return null;
  }
  const match = scriptPath.match(/^(.*[\\/]_npx)[\\/]/);
  return match ? match[1] : null;
}

/**
 * Explain why no connector is available for a DSN when its connector was skipped
 * at startup for a missing package, and how to recover. Returns null when the DSN
 * does not belong to a skipped connector.
 */
export function getMissingDriverHint(
  dsn: string,
  scriptPath: string | undefined = process.argv[1]
): string | null {
  const scheme = dsn.split("://", 1)[0].toLowerCase();
  const skipped = skippedConnectors.find((c) => c.schemes.includes(scheme));
  if (!skipped) {
    return null;
  }

  const cause = `The ${skipped.name} connector was skipped at startup because the package "${skipped.missing}" is not installed.`;
  const npxCacheDir = getNpxCacheDir(scriptPath);
  if (npxCacheDir) {
    // Some npm releases (seen on 11.6.2, not on 11.16.0) drop optional driver
    // packages when npx upgrades a cached install in place. See issue #524.
    return (
      `${cause} DBHub is running from the npx cache, where some npm versions drop optional driver packages ` +
      `when upgrading a cached install. Delete the npx cache directory (${npxCacheDir}) and restart, ` +
      `or upgrade npm (npm install -g npm@latest).`
    );
  }
  return `${cause} Install it next to DBHub (for a global install: npm install -g ${skipped.missing}) and restart.`;
}

/**
 * Load connector modules, gracefully skipping any whose driver package
 * is not installed.
 */
export async function loadConnectors(
  connectorModules: ConnectorModule[]
): Promise<void> {
  skippedConnectors.length = 0;
  await Promise.all(
    connectorModules.map(async ({ load, name, driver, schemes = [] }) => {
      try {
        await load();
      } catch (err) {
        if (isDriverNotInstalled(err, driver)) {
          skippedConnectors.push({ name, missing: driver, schemes });
          console.error(
            `Skipping ${name} connector: driver package "${driver}" not installed.`
          );
        } else if (isModuleNotFound(err)) {
          // Transitive dependency missing (e.g. mssql installed but @azure/core-client is not)
          const msg = err instanceof Error ? err.message : String(err);
          const match = msg.match(MISSING_MODULE_RE);
          const missing = match ? match[1] : "unknown";
          skippedConnectors.push({ name, missing, schemes });
          console.error(
            `Skipping ${name} connector: required dependency "${missing}" not installed.`
          );
        } else {
          throw err;
        }
      }
    })
  );
}
