import { describe, it, expect } from "vitest";
import {
  detectParameterStyle,
  validateParameterStyle,
  countParameters,
  validateParameters,
  mapArgumentsToArray,
} from "../parameter-mapper.js";
import type { ParameterConfig } from "../../types/config.js";
import type { ConnectorType } from "../../connectors/interface.js";

const idParam: ParameterConfig = { name: "id", type: "integer", description: "User ID" };
const statusParam: ParameterConfig = { name: "status", type: "string", description: "User status" };

describe("Parameter Mapper", () => {
  // The masking rules themselves (comments, strings, escaped quotes, dialects)
  // are covered in sql-parser.test.ts. These two only prove that
  // detectParameterStyle and countParameters strip before matching.
  describe("comment and string masking", () => {
    it("should detect real parameter after string containing $1", () => {
      const sql = "SELECT 'cost is $1' AS label, * FROM products WHERE id = $1";
      expect(detectParameterStyle(sql)).toBe("numbered");
    });

    it("should not count parameters inside strings", () => {
      const sql = "SELECT '$1 $2 $3' AS text FROM test WHERE id = $1";
      expect(countParameters(sql)).toBe(1);
    });
  });

  describe("detectParameterStyle", () => {
    it.each([
      ["SELECT * FROM users WHERE id = $1 AND status = $2", "numbered"],
      ["SELECT * FROM users WHERE id = ? AND status = ?", "positional"],
      ["SELECT * FROM users WHERE id = @p1 AND status = @p2", "named"],
      ["SELECT * FROM users WHERE id = :1 AND status = :2", "colon"],
      ["SELECT * FROM users", "none"],
      // A PostgreSQL cast is not a colon parameter
      ["SELECT '1'::int FROM t", "none"],
      ["SELECT * FROM t WHERE id = $1 AND x = '5'::int", "numbered"],
    ])("should detect %j as %s", (sql, style) => {
      expect(detectParameterStyle(sql)).toBe(style);
    });
  });

  describe("validateParameterStyle", () => {
    it.each<[string, ConnectorType]>([
      ["SELECT * FROM users WHERE id = $1", "postgres"],
      ["SELECT * FROM users WHERE id = ?", "mysql"],
      ["SELECT * FROM users WHERE id = @p1", "sqlserver"],
      ["SELECT * FROM users WHERE id = :1", "oracle"],
      // SQL without parameters is valid for any connector
      ["SELECT * FROM users", "postgres"],
      ["SELECT * FROM users", "mysql"],
      ["SELECT * FROM users", "sqlserver"],
    ])("should accept %j for %s", (sql, connector) => {
      expect(() => validateParameterStyle(sql, connector)).not.toThrow();
    });

    it.each<[string, ConnectorType, RegExp]>([
      ["SELECT * FROM users WHERE id = ?", "postgres", /Invalid parameter syntax for postgres/],
      ["SELECT * FROM users WHERE id = $1", "mysql", /Invalid parameter syntax for mysql/],
      ["SELECT * FROM users WHERE id = ?", "oracle", /Expected colon style \(:1, :2, :3\)/],
    ])("should reject %j for %s", (sql, connector, message) => {
      expect(() => validateParameterStyle(sql, connector)).toThrow(message);
    });
  });

  describe("countParameters", () => {
    it("should ignore a :N inside an Oracle q-quoted literal when given the dialect", () => {
      const sql = "SELECT q'[it's :1]' AS s FROM t WHERE id = :1";
      expect(countParameters(sql, "oracle")).toBe(1);
      expect(() => validateParameters(sql, [{ name: "id", type: "integer", description: "id" }], "oracle")).not.toThrow();
    });

    it("should reject a zero index in every indexed style", () => {
      expect(() => countParameters("SELECT * FROM t WHERE id = $0")).toThrow(/parameter \$0/);
      expect(() => countParameters("SELECT * FROM t WHERE id = @p0")).toThrow(/parameter @p0/);
      expect(() => countParameters("SELECT * FROM t WHERE id = :0", "oracle")).toThrow(/parameter :0/);
    });

    it("should count and validate Oracle colon-numbered parameters", () => {
      expect(countParameters("SELECT * FROM users WHERE id = :1 AND x = :2 OR y = :1")).toBe(2);
      expect(() => countParameters("SELECT * FROM users WHERE id = :1 AND x = :3")).toThrow(
        /missing :2/
      );
    });

    it.each([
      // [style, placeholder for index n]
      ["numbered", (n: number) => `$${n}`],
      ["positional", () => "?"],
      ["named", (n: number) => `@p${n}`],
    ])("should count %s parameters correctly", (_style, p) => {
      expect(countParameters(`SELECT * FROM users WHERE id = ${p(1)}`)).toBe(1);
      expect(countParameters(`SELECT * FROM users WHERE id = ${p(1)} AND status = ${p(2)}`)).toBe(2);
      expect(
        countParameters(`SELECT * FROM users WHERE id = ${p(1)} AND status = ${p(2)} AND role = ${p(3)}`)
      ).toBe(3);
    });

    it("should return 0 for SQL without parameters", () => {
      expect(countParameters("SELECT * FROM users")).toBe(0);
    });

    it("should reject non-sequential numbered parameters", () => {
      // Non-sequential: $1, $3 (missing $2) should throw
      expect(() => countParameters("SELECT * WHERE a = $1 AND b = $3")).toThrow(
        /Non-sequential numbered parameters.*missing \$2/
      );
      // Starting from $2 instead of $1 should throw
      expect(() => countParameters("SELECT * WHERE a = $2 AND b = $5 AND c = $7")).toThrow(
        /Non-sequential numbered parameters.*missing \$1/
      );
    });

    it("should allow reused numbered parameters", () => {
      // Reused $1 should count as 1 parameter (valid)
      expect(countParameters("SELECT * WHERE id = $1 OR parent_id = $1")).toBe(1);
      // Reused $1 and sequential $2 should count as 2 parameters (valid)
      expect(countParameters("SELECT * WHERE (id = $1 OR parent_id = $1) AND status = $2")).toBe(2);
    });

    it("should reject non-sequential named parameters", () => {
      // Non-sequential: @p1, @p3 (missing @p2) should throw
      expect(() => countParameters("SELECT * WHERE a = @p1 AND b = @p3")).toThrow(
        /Non-sequential named parameters.*missing @p2/
      );
      // Non-sequential: @p2, @p5 (missing @p1, @p3, @p4) should throw
      expect(() => countParameters("SELECT * WHERE a = @p2 AND b = @p5")).toThrow(
        /Non-sequential named parameters.*missing @p1/
      );
    });

    it("should allow reused named parameters", () => {
      // Reused @p1 should count as 1 parameter (valid)
      expect(countParameters("SELECT * WHERE id = @p1 OR parent_id = @p1")).toBe(1);
      // Reused @p1 and sequential @p2 should count as 2 parameters (valid)
      expect(countParameters("SELECT * WHERE (id = @p1 OR parent_id = @p1) AND status = @p2")).toBe(2);
    });
  });

  describe("validateParameters", () => {
    it("should accept matching parameter count for postgres", () => {
      const sql = "SELECT * FROM users WHERE id = $1 AND status = $2";
      expect(() => validateParameters(sql, [idParam, statusParam], "postgres")).not.toThrow();
    });

    it("should reject mismatched parameter count", () => {
      const sql = "SELECT * FROM users WHERE id = $1";
      expect(() => validateParameters(sql, [idParam, statusParam], "postgres")).toThrow(
        /Parameter count mismatch/
      );
    });

    it("should accept SQL without parameters and empty params array", () => {
      const sql = "SELECT * FROM users";
      expect(() => validateParameters(sql, [], "postgres")).not.toThrow();
      expect(() => validateParameters(sql, undefined, "postgres")).not.toThrow();
    });

    it("should reject SQL with parameters but no params array", () => {
      const sql = "SELECT * FROM users WHERE id = $1";
      expect(() => validateParameters(sql, undefined, "postgres")).toThrow(
        /Parameter count mismatch/
      );
    });
  });

  describe("mapArgumentsToArray", () => {
    it("should map simple arguments to array in order", () => {
      const args = { id: 123, status: "active" };
      expect(mapArgumentsToArray([idParam, statusParam], args)).toEqual([123, "active"]);
    });

    it("should use default values for missing optional parameters", () => {
      const params: ParameterConfig[] = [idParam, { ...statusParam, default: "pending" }];
      expect(mapArgumentsToArray(params, { id: 123 })).toEqual([123, "pending"]);
    });

    it("should throw for missing required parameters without defaults", () => {
      expect(() => mapArgumentsToArray([idParam, statusParam], { id: 123 })).toThrow(
        /Required parameter 'status' is missing/
      );
    });

    it.each([
      ["empty", []],
      ["undefined", undefined],
    ])("should return an empty array for %s parameters", (_, params) => {
      expect(mapArgumentsToArray(params, {})).toEqual([]);
    });

    it("should use null for optional parameters without default", () => {
      const params: ParameterConfig[] = [idParam, { ...statusParam, required: false }];
      expect(mapArgumentsToArray(params, { id: 123 })).toEqual([123, null]);
    });
  });
});
