import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getMissingDriverHint,
  getNpxCacheDir,
  isDriverNotInstalled,
  isModuleNotFound,
  loadConnectors,
} from "../utils/module-loader.js";

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The error Node raises when an ESM import cannot be resolved. */
const missingModule = (specifier: string): Error =>
  withCode(`Cannot find package '${specifier}' imported from /fake/path`, "ERR_MODULE_NOT_FOUND");

/** mssql is installed but its transitive dependency @azure/core-client is not (CJS). */
const missingTransitive = (): Error =>
  withCode("Cannot find module '@azure/core-client'", "MODULE_NOT_FOUND");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isDriverNotInstalled", () => {
  it.each([
    [true, "the driver package is missing", "pg", "pg"],
    [true, "a scoped driver package is missing", "@aws-sdk/rds-signer", "@aws-sdk/rds-signer"],
    [true, "a subpath import of the driver is missing", "mysql2/promise", "mysql2"],
    [false, "a different driver is missing", "pg", "mysql2"],
    [false, "the missing module only contains the driver name as a substring", "pg-connection-string", "pg"],
  ])("should return %s when %s", (expected, _label, missing, driver) => {
    expect(isDriverNotInstalled(missingModule(missing), driver)).toBe(expected);
  });

  it("should return false for non-module errors and non-Error values", () => {
    expect(isDriverNotInstalled(new Error("Some other error"), "pg")).toBe(false);
    expect(isDriverNotInstalled("string error", "pg")).toBe(false);
    expect(isDriverNotInstalled(null, "pg")).toBe(false);
    expect(isDriverNotInstalled(undefined, "pg")).toBe(false);
  });
});

describe("isModuleNotFound", () => {
  it("should return true for ESM ERR_MODULE_NOT_FOUND and CJS MODULE_NOT_FOUND", () => {
    expect(isModuleNotFound(missingModule("pg"))).toBe(true);
    expect(isModuleNotFound(missingTransitive())).toBe(true);
  });

  it("should return false for unrelated errors and non-Error values", () => {
    expect(isModuleNotFound(new Error("Some other error"))).toBe(false);
    expect(isModuleNotFound("string error")).toBe(false);
    expect(isModuleNotFound(null)).toBe(false);
  });
});

describe("loadConnectors", () => {
  it("should log and continue when a driver is missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await loadConnectors([
      { load: () => Promise.reject(missingModule("pg")), name: "PostgreSQL", driver: "pg" },
    ]);

    expect(errorSpy).toHaveBeenCalledWith(
      'Skipping PostgreSQL connector: driver package "pg" not installed.'
    );
  });

  it("should rethrow non-driver errors", async () => {
    const runtimeErr = new Error("Unexpected syntax error");

    await expect(
      loadConnectors([
        { load: () => Promise.reject(runtimeErr), name: "PostgreSQL", driver: "pg" },
      ])
    ).rejects.toThrow("Unexpected syntax error");
  });

  it("should log, continue and later name a missing transitive dependency (CJS MODULE_NOT_FOUND)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await loadConnectors([
      {
        load: () => Promise.reject(missingTransitive()),
        name: "SQL Server",
        driver: "mssql",
        schemes: ["sqlserver"],
      },
    ]);

    expect(errorSpy).toHaveBeenCalledWith(
      'Skipping SQL Server connector: required dependency "@azure/core-client" not installed.'
    );
    expect(getMissingDriverHint("sqlserver://localhost/db", "/opt/dbhub/dist/index.js")).toContain(
      'the package "@azure/core-client" is not installed'
    );
  });

  it("should load all connectors when drivers are available", async () => {
    let loaded = 0;
    await loadConnectors([
      { load: async () => { loaded++; }, name: "TestDB", driver: "test-driver" },
    ]);
    expect(loaded).toBe(1);
  });
});

describe("getNpxCacheDir", () => {
  it("should find the npx cache directory in POSIX and Windows paths", () => {
    expect(
      getNpxCacheDir("/home/me/.npm/_npx/abc123/node_modules/.bin/dbhub")
    ).toBe("/home/me/.npm/_npx");
    expect(
      getNpxCacheDir(
        "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\@bytebase\\dbhub\\dist\\index.js"
      )
    ).toBe("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx");
  });

  it("should return null outside an npx cache", () => {
    expect(getNpxCacheDir("/usr/local/lib/node_modules/@bytebase/dbhub/dist/index.js")).toBeNull();
    expect(getNpxCacheDir(undefined)).toBeNull();
  });
});

describe("getMissingDriverHint", () => {
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await loadConnectors([
      {
        load: () => Promise.reject(missingModule("pg")),
        name: "PostgreSQL",
        driver: "pg",
        schemes: ["postgres", "postgresql"],
      },
      { load: () => Promise.resolve(), name: "MySQL", driver: "mysql2", schemes: ["mysql"] },
    ]);
  });

  it("should point npx users at the npx cache", () => {
    const hint = getMissingDriverHint(
      "postgres://user:pass@localhost:5432/db",
      "/home/me/.npm/_npx/abc123/node_modules/.bin/dbhub"
    );

    expect(hint).toContain('the package "pg" is not installed');
    expect(hint).toContain("Delete the npx cache directory (/home/me/.npm/_npx)");
    expect(hint).not.toContain("pass");
  });

  it("should suggest installing the driver outside npx", () => {
    const hint = getMissingDriverHint(
      "postgresql://localhost/db",
      "/usr/local/lib/node_modules/@bytebase/dbhub/dist/index.js"
    );

    expect(hint).toContain("npm install -g pg");
    expect(hint).not.toContain("npx");
  });

  it("should return null for a DSN whose connector loaded", () => {
    expect(getMissingDriverHint("mysql://localhost/db")).toBeNull();
    expect(getMissingDriverHint("not-a-dsn")).toBeNull();
  });
});
