import { describe, it, expect } from "vitest";
import { isDorisVersionComment, isTiDBVersion } from "../server-flavor.js";

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

describe("isDorisVersionComment", () => {
  it("detects Apache Doris from @@version_comment", () => {
    expect(isDorisVersionComment("Doris version doris-4.0.8-rc01-1234abcd")).toBe(true);
    expect(isDorisVersionComment("Doris version 2.1.7")).toBe(true);
    expect(isDorisVersionComment("doris version doris-3.0.3")).toBe(true);
  });

  it("does not match other MySQL-protocol servers", () => {
    expect(isDorisVersionComment("MySQL Community Server - GPL")).toBe(false);
    expect(isDorisVersionComment("mariadb.org binary distribution")).toBe(false);
    expect(isDorisVersionComment("TiDB Server (Apache License 2.0) Community Edition")).toBe(false);
    // A mention is not a match: only a comment that leads with the product name.
    expect(isDorisVersionComment("Not Doris, a build named after it")).toBe(false);
    expect(isDorisVersionComment("Dorisoft Server")).toBe(false);
  });

  it("is safe when the comment is missing or not a string", () => {
    expect(isDorisVersionComment(undefined)).toBe(false);
    expect(isDorisVersionComment(null)).toBe(false);
    expect(isDorisVersionComment("")).toBe(false);
    expect(isDorisVersionComment(42)).toBe(false);
  });
});
