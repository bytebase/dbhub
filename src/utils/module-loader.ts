// Matches the package name from Node.js ERR_MODULE_NOT_FOUND messages:
//   Cannot find package 'pg' imported from ...
//   Cannot find module 'pg' ...
const MISSING_MODULE_RE = /Cannot find (?:package|module) '([^']+)'/;

/**
 * Check if an error is an ERR_MODULE_NOT_FOUND for a specific driver package.
 * This distinguishes a missing optional driver (e.g. "pg" not installed) from
 * other module errors (e.g. a missing internal dependency like "pg-connection-string").
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
  // Match the exact driver package or a subpath import (e.g. "mysql2/promise")
  return (
    missingSpecifier === driver ||
    missingSpecifier.startsWith(`${driver}/`)
  );
}
