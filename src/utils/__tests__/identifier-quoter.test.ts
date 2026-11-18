import { describe, it, expect } from "vitest";
import { quoteIdentifier, quoteQualifiedIdentifier } from "../identifier-quoter.js";
import type { ConnectorType } from "../../connectors/interface.js";

describe("quoteIdentifier", () => {
  // quoteIdentifier has four quoting branches (double quotes, backticks, backticks
  // with backslash escapes, square brackets). Each dialect gets one plain row and one row exercising its escape
  // rule; spaces, dots and reserved words take the same path as a plain name.
  it.each<[ConnectorType, string, string]>([
    ["postgres", "users", '"users"'],
    ["postgres", 'table"name', '"table""name"'],
    ["sqlite", "users", '"users"'],
    ["sqlite", 'table"name', '"table""name"'],
    ["oracle", "users", '"users"'],
    ["oracle", 'table"name', '"table""name"'],
    ["mysql", "users", "`users`"],
    ["mysql", "table`name", "`table``name`"],
    ["mariadb", "users", "`users`"],
    ["mariadb", "table`name", "`table``name`"],
    ["clickhouse", "users", "`users`"],
    // A backslash is an escape character inside a ClickHouse quoted identifier
    ["clickhouse", "table`name", "`table\\`name`"],
    ["clickhouse", "back\\slash", "`back\\\\slash`"],
    ["sqlserver", "users", "[users]"],
    ["sqlserver", "table]name", "[table]]name]"],
    // Only the closing bracket is escaped, so "table[1]" becomes "[table[1]]]"
    ["sqlserver", "table[1]", "[table[1]]]"],
  ])("should quote %s identifier %s as %s", (dbType, input, expected) => {
    expect(quoteIdentifier(input, dbType)).toBe(expected);
  });

  describe("Validation", () => {
    it.each([
      ["null bytes", "table\0name"],
      ["newlines", "table\nname"],
      ["carriage returns", "table\rname"],
    ])("should reject identifiers with %s", (_, identifier) => {
      expect(() => quoteIdentifier(identifier, "postgres")).toThrow(
        "Invalid identifier: contains control characters"
      );
    });

    it("should reject empty identifiers", () => {
      expect(() => quoteIdentifier("", "postgres")).toThrow("Identifier cannot be empty");
    });
  });
});

describe("quoteQualifiedIdentifier", () => {
  it("should quote table only when schema is not provided", () => {
    expect(quoteQualifiedIdentifier("users", undefined, "postgres")).toBe('"users"');
  });

  it("should quote both schema and table when schema is provided", () => {
    expect(quoteQualifiedIdentifier("users", "public", "postgres")).toBe('"public"."users"');
  });
});
