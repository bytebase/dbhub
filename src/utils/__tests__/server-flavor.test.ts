import { describe, it, expect } from "vitest";
import { detectMySQLServerFlavor, isTiDBVersion } from "../server-flavor.js";

describe("isTiDBVersion", () => {
  it("detects TiDB version strings", () => {
    expect(isTiDBVersion("8.0.11-TiDB-v7.5.0")).toBe(true);
    expect(isTiDBVersion("5.7.25-TiDB-v6.1.0-serverless")).toBe(true);
    expect(isTiDBVersion("8.0.11-tidb-v7.5.0")).toBe(true);
  });

  it("treats stock MySQL and MariaDB as supporting READ ONLY transactions", () => {
    expect(isTiDBVersion("8.0.36")).toBe(false);
    expect(isTiDBVersion("5.7.44-log")).toBe(false);
    expect(isTiDBVersion("11.4.2-MariaDB-ubu2404")).toBe(false);
  });

  it("is safe when the version is missing or not a string", () => {
    expect(isTiDBVersion(undefined)).toBe(false);
    expect(isTiDBVersion(null)).toBe(false);
    expect(isTiDBVersion(80036)).toBe(false);
  });
});

describe("detectMySQLServerFlavor", () => {
  it.each([
    ["5.7.44", "mysql_5_7"],
    ["5.7.44-log", "mysql_5_7"],
    ["8.0.36", "mysql_8"],
    ["8.4.0", "mysql_8"],
    ["8.4.10-log", "mysql_8"],
    ["9.0.1", "mysql_9"],
    ["9.7.1", "mysql_9"],
    ["9.7.1-log", "mysql_9"],
    ["8.0.11-TiDB-v7.5.0", "tidb"],
    ["11.4.2-MariaDB-ubu2404", "unsupported_or_unknown"],
    ["8.0.36-Percona", "unsupported_or_unknown"],
    ["8.0.36-28", "unsupported_or_unknown"],
    ["8.0.36-28-log", "unsupported_or_unknown"],
    ["9.7.1-UNKNOWN_VENDOR", "unsupported_or_unknown"],
    ["9.7.1+vendor.1", "unsupported_or_unknown"],
    ["5.6.51", "unsupported_or_unknown"],
    ["10.0.0", "unsupported_or_unknown"],
    ["not-a-version", "unsupported_or_unknown"],
    [undefined, "unsupported_or_unknown"],
  ])("maps %j to %s", (version, expected) => {
    expect(detectMySQLServerFlavor(version)).toBe(expected);
  });
});
