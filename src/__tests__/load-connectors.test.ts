import { describe, it, expect } from "vitest";
import { isDriverNotInstalled } from "../utils/module-loader.js";

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
