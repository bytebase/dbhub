import { describe, it, expect, vi } from "vitest";
import { isDriverNotInstalled, loadConnectors } from "../utils/module-loader.js";

describe("isDriverNotInstalled", () => {
  it("should return true when the driver package is missing", () => {
    const err = new Error(
      "Cannot find package 'pg' imported from /fake/path"
    );
    (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";

    expect(isDriverNotInstalled(err, "pg")).toBe(true);
  });

  it("should return false when a different driver is missing", () => {
    const err = new Error(
      "Cannot find package 'pg' imported from /fake/path"
    );
    (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";

    expect(isDriverNotInstalled(err, "mysql2")).toBe(false);
  });

  it("should return true for driver subpath imports", () => {
    const err = new Error(
      "Cannot find package 'mysql2/promise' imported from /fake/path"
    );
    (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";

    expect(isDriverNotInstalled(err, "mysql2")).toBe(true);
  });

  it("should return false when missing module name only contains driver as a substring", () => {
    const err = new Error(
      "Cannot find package 'pg-connection-string' imported from /fake/path"
    );
    (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";

    expect(isDriverNotInstalled(err, "pg")).toBe(false);
  });

  it("should return false for unrelated ERR_MODULE_NOT_FOUND errors", () => {
    const err = new Error(
      "Cannot find package 'some-internal-dep' imported from /fake/path"
    );
    (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";

    expect(isDriverNotInstalled(err, "pg")).toBe(false);
    expect(isDriverNotInstalled(err, "mysql2")).toBe(false);
  });

  it("should return false for non-module errors", () => {
    const err = new Error("Some other error");
    expect(isDriverNotInstalled(err, "pg")).toBe(false);
  });

  it("should return false for non-Error values", () => {
    expect(isDriverNotInstalled("string error", "pg")).toBe(false);
    expect(isDriverNotInstalled(null, "pg")).toBe(false);
    expect(isDriverNotInstalled(undefined, "pg")).toBe(false);
  });
});

describe("loadConnectors", () => {
  it("should log and continue when a driver is missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const driverErr = new Error("Cannot find package 'pg' imported from /fake/path");
    (driverErr as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";

    await loadConnectors([
      { load: () => Promise.reject(driverErr), name: "PostgreSQL", driver: "pg" },
    ]);

    expect(errorSpy).toHaveBeenCalledWith(
      'Skipping PostgreSQL connector: driver package "pg" not installed.'
    );
    errorSpy.mockRestore();
  });

  it("should rethrow non-driver errors", async () => {
    const runtimeErr = new Error("Unexpected syntax error");

    await expect(
      loadConnectors([
        { load: () => Promise.reject(runtimeErr), name: "PostgreSQL", driver: "pg" },
      ])
    ).rejects.toThrow("Unexpected syntax error");
  });

  it("should load all connectors when drivers are available", async () => {
    let loaded = 0;
    await loadConnectors([
      { load: async () => { loaded++; }, name: "TestDB", driver: "test-driver" },
    ]);
    expect(loaded).toBe(1);
  });
});
