import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveSourceConfigs } from "../env.js";

/**
 * Tests for DSN parsing with special characters in passwords
 *
 * This test suite covers the regression introduced in commit f3508c0 where
 * native URL() constructor replaced SafeURL for DSN parsing. The native URL()
 * constructor fails to parse DSN strings with unencoded special characters in
 * passwords, treating characters like @, :, / as URL delimiters rather than
 * password content.
 */
describe("DSN Parsing with Special Characters in Passwords", () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear environment variables to ensure we're testing CLI args only
    delete process.env.DSN;
    delete process.env.DB_TYPE;
    delete process.env.DB_HOST;
    delete process.env.DB_USER;
    delete process.env.DB_PASSWORD;
    delete process.env.DB_NAME;
  });

  afterEach(() => {
    // Restore original state
    process.argv = originalArgv;
    process.env = { ...originalEnv };
  });

  describe("PostgreSQL DSN with special characters", () => {
    it("should parse password with @ symbol correctly", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=postgres://user:my@pass@localhost:5432/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources).toHaveLength(1);
      expect(result!.sources[0].type).toBe("postgres");
      expect(result!.sources[0].dsn).toBe("postgres://user:my@pass@localhost:5432/testdb");
    });

    it("should parse password with : symbol correctly", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=postgres://user:my:pass:word@localhost:5432/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("postgres");
      expect(result!.sources[0].dsn).toBe("postgres://user:my:pass:word@localhost:5432/testdb");
    });

    it("should parse password with / symbol correctly", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=postgres://user:pass/word@localhost:5432/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("postgres");
      expect(result!.sources[0].dsn).toBe("postgres://user:pass/word@localhost:5432/testdb");
    });

    it("should parse password with multiple special characters", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=postgres://user:p@ss:w/rd#123@localhost:5432/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("postgres");
      expect(result!.sources[0].dsn).toBe("postgres://user:p@ss:w/rd#123@localhost:5432/testdb");
    });

    it("should parse password with query string special characters", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=postgres://user:my&pass=word@localhost:5432/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("postgres");
      expect(result!.sources[0].dsn).toBe("postgres://user:my&pass=word@localhost:5432/testdb");
    });
  });

  describe("MySQL DSN with special characters", () => {
    it("should parse password with @ symbol correctly", async () => {
      process.argv = ["node", "script.js", "--dsn=mysql://user:my@pass@localhost:3306/testdb"];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources).toHaveLength(1);
      expect(result!.sources[0].type).toBe("mysql");
      expect(result!.sources[0].dsn).toBe("mysql://user:my@pass@localhost:3306/testdb");
    });

    it("should parse password with : symbol correctly", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=mysql://user:my:pass:word@localhost:3306/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("mysql");
      expect(result!.sources[0].dsn).toBe("mysql://user:my:pass:word@localhost:3306/testdb");
    });

    it("should parse password with / symbol correctly", async () => {
      process.argv = ["node", "script.js", "--dsn=mysql://user:pass/word@localhost:3306/testdb"];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("mysql");
      expect(result!.sources[0].dsn).toBe("mysql://user:pass/word@localhost:3306/testdb");
    });

    it("should parse password with multiple special characters", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=mysql://user:p@ss:w/rd#123@localhost:3306/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("mysql");
      expect(result!.sources[0].dsn).toBe("mysql://user:p@ss:w/rd#123@localhost:3306/testdb");
    });

    it("should parse password with query string special characters", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=mysql://user:my&pass=word@localhost:3306/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("mysql");
      expect(result!.sources[0].dsn).toBe("mysql://user:my&pass=word@localhost:3306/testdb");
    });
  });

  describe("MariaDB DSN with special characters", () => {
    it("should parse password with @ symbol correctly", async () => {
      process.argv = ["node", "script.js", "--dsn=mariadb://user:my@pass@localhost:3306/testdb"];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources).toHaveLength(1);
      expect(result!.sources[0].type).toBe("mariadb");
      expect(result!.sources[0].dsn).toBe("mariadb://user:my@pass@localhost:3306/testdb");
    });

    it("should parse password with : symbol correctly", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=mariadb://user:my:pass:word@localhost:3306/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("mariadb");
      expect(result!.sources[0].dsn).toBe("mariadb://user:my:pass:word@localhost:3306/testdb");
    });

    it("should parse password with / symbol correctly", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=mariadb://user:pass/word@localhost:3306/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("mariadb");
      expect(result!.sources[0].dsn).toBe("mariadb://user:pass/word@localhost:3306/testdb");
    });

    it("should parse password with multiple special characters", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=mariadb://user:p@ss:w/rd#123@localhost:3306/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("mariadb");
      expect(result!.sources[0].dsn).toBe("mariadb://user:p@ss:w/rd#123@localhost:3306/testdb");
    });

    it("should parse password with query string special characters", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=mariadb://user:my&pass=word@localhost:3306/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("mariadb");
      expect(result!.sources[0].dsn).toBe("mariadb://user:my&pass=word@localhost:3306/testdb");
    });
  });

  describe("SQL Server DSN with special characters", () => {
    it("should parse password with @ symbol correctly", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=sqlserver://user:my@pass@localhost:1433/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources).toHaveLength(1);
      expect(result!.sources[0].type).toBe("sqlserver");
      expect(result!.sources[0].dsn).toBe("sqlserver://user:my@pass@localhost:1433/testdb");
    });

    it("should parse password with : symbol correctly", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=sqlserver://user:my:pass:word@localhost:1433/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("sqlserver");
      expect(result!.sources[0].dsn).toBe("sqlserver://user:my:pass:word@localhost:1433/testdb");
    });

    it("should parse password with / symbol correctly", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=sqlserver://user:pass/word@localhost:1433/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("sqlserver");
      expect(result!.sources[0].dsn).toBe("sqlserver://user:pass/word@localhost:1433/testdb");
    });

    it("should parse password with multiple special characters", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=sqlserver://user:p@ss:w/rd#123@localhost:1433/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("sqlserver");
      expect(result!.sources[0].dsn).toBe("sqlserver://user:p@ss:w/rd#123@localhost:1433/testdb");
    });

    it("should parse password with query string special characters", async () => {
      process.argv = [
        "node",
        "script.js",
        "--dsn=sqlserver://user:my&pass=word@localhost:1433/testdb",
      ];

      const result = await resolveSourceConfigs();

      expect(result).not.toBeNull();
      expect(result!.sources[0].type).toBe("sqlserver");
      expect(result!.sources[0].dsn).toBe("sqlserver://user:my&pass=word@localhost:1433/testdb");
    });
  });
});
