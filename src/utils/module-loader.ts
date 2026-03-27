/**
 * Check if an error is an ERR_MODULE_NOT_FOUND for a specific driver package.
 * This distinguishes a missing optional driver (e.g. "pg" not installed) from
 * other module errors (e.g. a typo in an internal import).
 */
export function isDriverNotInstalled(err: unknown, driver: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" &&
    err.message.includes(driver)
  );
}
