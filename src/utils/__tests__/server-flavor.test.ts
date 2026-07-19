import { describe, it, expect } from "vitest";
import { isTiDBVersion } from "../server-flavor.js";

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
