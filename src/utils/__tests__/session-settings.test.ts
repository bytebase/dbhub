import { describe, it, expect } from "vitest";
import {
  buildMySQLSessionStatement,
  buildPostgresSessionOptions,
  validateSessionSettings,
} from "../session-settings.js";

// Loader-level validation (names, managed settings, value types) is covered in
// toml-loader.test.ts; these tests pin how valid settings are rendered.
describe("buildMySQLSessionStatement", () => {
  it("should render every setting in one SET SESSION statement", () => {
    expect(
      buildMySQLSessionStatement({
        transaction_read_only: 1,
        lock_wait_timeout: 5,
        sql_safe_updates: true,
        foreign_key_checks: false,
        time_zone: "+09:00",
      })
    ).toBe(
      "SET SESSION transaction_read_only = 1, lock_wait_timeout = 5, sql_safe_updates = TRUE, " +
        "foreign_key_checks = FALSE, time_zone = '+09:00'"
    );
  });

  it("should keep a quote inside a string value as part of the literal", () => {
    expect(buildMySQLSessionStatement({ sql_mode: "x', autocommit = '0" })).toBe(
      "SET SESSION sql_mode = 'x'', autocommit = ''0'"
    );
  });

  it("should render a TOML integer beyond the safe range in full", () => {
    expect(buildMySQLSessionStatement({ max_heap_table_size: 9223372036854775807n })).toBe(
      "SET SESSION max_heap_table_size = 9223372036854775807"
    );
  });

  it("should return undefined for an empty table", () => {
    expect(buildMySQLSessionStatement({})).toBeUndefined();
  });
});

describe("buildPostgresSessionOptions", () => {
  it("should render each setting as a -c startup option", () => {
    expect(
      buildPostgresSessionOptions({
        lock_timeout: "5s",
        idle_in_transaction_session_timeout: 60000,
        jit: false,
        "pg_stat_statements.track": "all",
      })
    ).toBe(
      " -c lock_timeout=5s -c idle_in_transaction_session_timeout=60000 -c jit=off" +
        " -c pg_stat_statements.track=all"
    );
  });

  it("should escape whitespace and backslashes so a value cannot add an option", () => {
    expect(buildPostgresSessionOptions({ application_name: "a -c\tb\\c" })).toBe(
      " -c application_name=a\\ -c\\\tb\\\\c"
    );
  });

  it("should return an empty string for an empty table", () => {
    expect(buildPostgresSessionOptions({})).toBe("");
  });
});

describe("validateSessionSettings", () => {
  it("should match managed setting names case-insensitively", () => {
    expect(validateSessionSettings({ Statement_Timeout: 0 }, "postgres")).toContain(
      "Use 'query_timeout' instead"
    );
  });

  it.each([NaN, Infinity])("should reject the non-finite number %s", (value) => {
    expect(validateSessionSettings({ lock_wait_timeout: value }, "mysql")).toContain(
      "invalid value for 'lock_wait_timeout'"
    );
  });

  it("should allow a backslash in a PostgreSQL string", () => {
    expect(validateSessionSettings({ application_name: "a\\b" }, "postgres")).toBeUndefined();
  });

  it("should reject a Date in place of the table", () => {
    // The TOML parser returns a Date for `session = 2024-01-01T00:00:00Z`; it has
    // no enumerable entries, so it must not pass as an empty table.
    expect(validateSessionSettings(new Date("2024-01-01T00:00:00Z"), "postgres")).toContain(
      "must be a table"
    );
  });
});
