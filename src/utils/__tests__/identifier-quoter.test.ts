import { describe, it, expect } from "vitest";
import { quoteIdentifier, quoteQualifiedIdentifier } from "../identifier-quoter.js";
import type { ConnectorType } from "../../connectors/interface.js";

describe("quoteIdentifier", () => {
  describe("PostgreSQL", () => {
    const dbType: ConnectorType = "postgres";

    it("should quote simple identifiers with double quotes", () => {
      expect(quoteIdentifier("users", dbType)).toBe('"users"');
      expect(quoteIdentifier("my_table", dbType)).toBe('"my_table"');
    });

    it("should handle identifiers with spaces", () => {
      expect(quoteIdentifier("user data", dbType)).toBe('"user data"');
      expect(quoteIdentifier("my table", dbType)).toBe('"my table"');
    });

    it("should escape double quotes by doubling them", () => {
      expect(quoteIdentifier('table"name', dbType)).toBe('"table""name"');
      expect(quoteIdentifier('a"b"c', dbType)).toBe('"a""b""c"');
    });

    it("should handle special characters", () => {
      expect(quoteIdentifier("table[1]", dbType)).toBe('"table[1]"');
      expect(quoteIdentifier("data.backup", dbType)).toBe('"data.backup"');
      expect(quoteIdentifier("user-data", dbType)).toBe('"user-data"');
      expect(quoteIdentifier("test@prod", dbType)).toBe('"test@prod"');
    });

    it("should handle reserved keywords", () => {
      expect(quoteIdentifier("select", dbType)).toBe('"select"');
      expect(quoteIdentifier("from", dbType)).toBe('"from"');
      expect(quoteIdentifier("where", dbType)).toBe('"where"');
    });
  });

  describe("MySQL", () => {
    const dbType: ConnectorType = "mysql";

    it("should quote simple identifiers with backticks", () => {
      expect(quoteIdentifier("users", dbType)).toBe("`users`");
      expect(quoteIdentifier("my_table", dbType)).toBe("`my_table`");
    });

    it("should handle identifiers with spaces", () => {
      expect(quoteIdentifier("user data", dbType)).toBe("`user data`");
    });

    it("should escape backticks by doubling them", () => {
      expect(quoteIdentifier("table`name", dbType)).toBe("`table``name`");
      expect(quoteIdentifier("a`b`c", dbType)).toBe("`a``b``c`");
    });

    it("should handle special characters", () => {
      expect(quoteIdentifier("table[1]", dbType)).toBe("`table[1]`");
      expect(quoteIdentifier("data.backup", dbType)).toBe("`data.backup`");
    });

    it("should handle reserved keywords", () => {
      expect(quoteIdentifier("select", dbType)).toBe("`select`");
      expect(quoteIdentifier("order", dbType)).toBe("`order`");
    });
  });

  describe("MariaDB", () => {
    const dbType: ConnectorType = "mariadb";

    it("should quote identifiers with backticks (same as MySQL)", () => {
      expect(quoteIdentifier("users", dbType)).toBe("`users`");
      expect(quoteIdentifier("table`name", dbType)).toBe("`table``name`");
    });
  });

  describe("SQLite", () => {
    const dbType: ConnectorType = "sqlite";

    it("should quote identifiers with double quotes (same as PostgreSQL)", () => {
      expect(quoteIdentifier("users", dbType)).toBe('"users"');
      expect(quoteIdentifier('table"name', dbType)).toBe('"table""name"');
    });

    it("should handle PRAGMA-safe identifiers", () => {
      expect(quoteIdentifier("users", dbType)).toBe('"users"');
      expect(quoteIdentifier("my_table", dbType)).toBe('"my_table"');
    });
  });

  describe("SQL Server", () => {
    const dbType: ConnectorType = "sqlserver";

    it("should quote simple identifiers with square brackets", () => {
      expect(quoteIdentifier("users", dbType)).toBe("[users]");
      expect(quoteIdentifier("my_table", dbType)).toBe("[my_table]");
    });

    it("should handle identifiers with spaces", () => {
      expect(quoteIdentifier("user data", dbType)).toBe("[user data]");
    });

    it("should escape closing brackets by doubling them", () => {
      expect(quoteIdentifier("table]name", dbType)).toBe("[table]]name]");
      expect(quoteIdentifier("a]b]c", dbType)).toBe("[a]]b]]c]");
    });

    it("should handle special characters", () => {
      // Note: SQL Server escapes closing brackets by doubling them
      // So "table[1]" becomes "[table[1]]]" (the closing bracket is escaped)
      expect(quoteIdentifier("table[1]", dbType)).toBe("[table[1]]]");
      expect(quoteIdentifier("data.backup", dbType)).toBe("[data.backup]");
    });

    it("should handle reserved keywords", () => {
      expect(quoteIdentifier("select", dbType)).toBe("[select]");
      expect(quoteIdentifier("user", dbType)).toBe("[user]");
    });
  });

  describe("Validation", () => {
    it("should reject identifiers with null bytes", () => {
      expect(() => quoteIdentifier("table\0name", "postgres")).toThrow(
        "Invalid identifier: contains control characters"
      );
    });

    it("should reject identifiers with newlines", () => {
      expect(() => quoteIdentifier("table\nname", "postgres")).toThrow(
        "Invalid identifier: contains control characters"
      );
    });

    it("should reject identifiers with carriage returns", () => {
      expect(() => quoteIdentifier("table\rname", "postgres")).toThrow(
        "Invalid identifier: contains control characters"
      );
    });

    it("should reject empty identifiers", () => {
      expect(() => quoteIdentifier("", "postgres")).toThrow("Identifier cannot be empty");
    });
  });
});

describe("quoteQualifiedIdentifier", () => {
  describe("PostgreSQL", () => {
    const dbType: ConnectorType = "postgres";

    it("should quote table only when schema is not provided", () => {
      expect(quoteQualifiedIdentifier("users", undefined, dbType)).toBe('"users"');
    });

    it("should quote both schema and table when schema is provided", () => {
      expect(quoteQualifiedIdentifier("users", "public", dbType)).toBe('"public"."users"');
    });

    it("should handle special characters in both parts", () => {
      expect(quoteQualifiedIdentifier("user data", "my schema", dbType)).toBe(
        '"my schema"."user data"'
      );
    });

    it("should escape quotes in both schema and table", () => {
      expect(quoteQualifiedIdentifier('table"name', 'schema"name', dbType)).toBe(
        '"schema""name"."table""name"'
      );
    });
  });

  describe("MySQL", () => {
    const dbType: ConnectorType = "mysql";

    it("should quote with backticks", () => {
      expect(quoteQualifiedIdentifier("users", "mydb", dbType)).toBe("`mydb`.`users`");
    });

    it("should escape backticks in both parts", () => {
      expect(quoteQualifiedIdentifier("table`name", "db`name", dbType)).toBe(
        "`db``name`.`table``name`"
      );
    });
  });

  describe("SQL Server", () => {
    const dbType: ConnectorType = "sqlserver";

    it("should quote with square brackets", () => {
      expect(quoteQualifiedIdentifier("users", "dbo", dbType)).toBe("[dbo].[users]");
    });

    it("should escape closing brackets in both parts", () => {
      expect(quoteQualifiedIdentifier("table]name", "schema]name", dbType)).toBe(
        "[schema]]name].[table]]name]"
      );
    });
  });
});
