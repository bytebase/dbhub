import { describe, it, expect } from "vitest";
import {
  detectParameterStyle,
  validateParameterStyle,
  countParameters,
  validateParameters,
  mapArgumentsToArray,
} from "../parameter-mapper.js";
import type { ParameterConfig } from "../../types/config.js";

describe("Parameter Mapper", () => {
  describe("detectParameterStyle - edge cases with comments and strings", () => {
    it("should not detect parameters inside single-quoted strings", () => {
      const sql = "SELECT 'price is $1' AS msg FROM products";
      expect(detectParameterStyle(sql)).toBe("none");
    });

    it("should not detect parameters inside double-quoted identifiers", () => {
      const sql = 'SELECT * FROM "table$1" WHERE active = true';
      expect(detectParameterStyle(sql)).toBe("none");
    });

    it("should not detect parameters inside single-line comments", () => {
      const sql = "SELECT * FROM users -- use $1 for filtering";
      expect(detectParameterStyle(sql)).toBe("none");
    });

    it("should not detect parameters inside multi-line comments", () => {
      const sql = "SELECT * FROM users /* parameter $1 */";
      expect(detectParameterStyle(sql)).toBe("none");
    });

    it("should detect real parameter after string containing $1", () => {
      const sql = "SELECT 'cost is $1' AS label, * FROM products WHERE id = $1";
      expect(detectParameterStyle(sql)).toBe("numbered");
    });

    it("should not detect question mark inside string", () => {
      const sql = "SELECT 'what?' AS question FROM faq";
      expect(detectParameterStyle(sql)).toBe("none");
    });

    it("should not detect @p1 inside string", () => {
      const sql = "SELECT 'contact @p1 for info' AS msg FROM users";
      expect(detectParameterStyle(sql)).toBe("none");
    });
  });

  describe("countParameters - edge cases with comments and strings", () => {
    it("should not count parameters inside strings", () => {
      const sql = "SELECT '$1 $2 $3' AS text FROM test WHERE id = $1";
      expect(countParameters(sql)).toBe(1);
    });

    it("should not count parameters inside comments", () => {
      const sql = "SELECT * FROM users WHERE id = $1 /* also filter by $2 $3 */";
      expect(countParameters(sql)).toBe(1);
    });

    it("should not count question marks inside strings", () => {
      const sql = "SELECT 'Is this ok?' AS question FROM faq WHERE id = ?";
      expect(countParameters(sql)).toBe(1);
    });

    it("should not count question marks inside comments", () => {
      const sql = "SELECT * FROM faq WHERE id = ? -- filter by ? later";
      expect(countParameters(sql)).toBe(1);
    });

    it("should handle escaped quotes in strings", () => {
      const sql = "SELECT 'it''s $1 value' AS text FROM test WHERE id = $1";
      expect(countParameters(sql)).toBe(1);
    });
  });

  describe("detectParameterStyle", () => {
    it("should detect numbered parameters ($1, $2)", () => {
      const sql = "SELECT * FROM users WHERE id = $1 AND status = $2";
      expect(detectParameterStyle(sql)).toBe("numbered");
    });

    it("should detect positional parameters (?)", () => {
      const sql = "SELECT * FROM users WHERE id = ? AND status = ?";
      expect(detectParameterStyle(sql)).toBe("positional");
    });

    it("should detect named parameters (@p1, @p2)", () => {
      const sql = "SELECT * FROM users WHERE id = @p1 AND status = @p2";
      expect(detectParameterStyle(sql)).toBe("named");
    });

    it("should return none for SQL without parameters", () => {
      const sql = "SELECT * FROM users";
      expect(detectParameterStyle(sql)).toBe("none");
    });
  });

  describe("validateParameterStyle", () => {
    it("should accept numbered parameters for postgres", () => {
      const sql = "SELECT * FROM users WHERE id = $1";
      expect(() => validateParameterStyle(sql, "postgres")).not.toThrow();
    });

    it("should accept positional parameters for mysql", () => {
      const sql = "SELECT * FROM users WHERE id = ?";
      expect(() => validateParameterStyle(sql, "mysql")).not.toThrow();
    });

    it("should accept named parameters for sqlserver", () => {
      const sql = "SELECT * FROM users WHERE id = @p1";
      expect(() => validateParameterStyle(sql, "sqlserver")).not.toThrow();
    });

    it("should reject positional parameters for postgres", () => {
      const sql = "SELECT * FROM users WHERE id = ?";
      expect(() => validateParameterStyle(sql, "postgres")).toThrow(
        /Invalid parameter syntax for postgres/
      );
    });

    it("should reject numbered parameters for mysql", () => {
      const sql = "SELECT * FROM users WHERE id = $1";
      expect(() => validateParameterStyle(sql, "mysql")).toThrow(
        /Invalid parameter syntax for mysql/
      );
    });

    it("should accept SQL without parameters for any connector", () => {
      const sql = "SELECT * FROM users";
      expect(() => validateParameterStyle(sql, "postgres")).not.toThrow();
      expect(() => validateParameterStyle(sql, "mysql")).not.toThrow();
      expect(() => validateParameterStyle(sql, "sqlserver")).not.toThrow();
    });
  });

  describe("countParameters", () => {
    it("should count numbered parameters correctly", () => {
      expect(countParameters("SELECT * FROM users WHERE id = $1")).toBe(1);
      expect(
        countParameters("SELECT * FROM users WHERE id = $1 AND status = $2")
      ).toBe(2);
      expect(
        countParameters(
          "SELECT * FROM users WHERE id = $1 AND status = $2 AND role = $3"
        )
      ).toBe(3);
    });

    it("should count positional parameters correctly", () => {
      expect(countParameters("SELECT * FROM users WHERE id = ?")).toBe(1);
      expect(
        countParameters("SELECT * FROM users WHERE id = ? AND status = ?")
      ).toBe(2);
      expect(
        countParameters(
          "SELECT * FROM users WHERE id = ? AND status = ? AND role = ?"
        )
      ).toBe(3);
    });

    it("should count named parameters correctly", () => {
      expect(countParameters("SELECT * FROM users WHERE id = @p1")).toBe(1);
      expect(
        countParameters("SELECT * FROM users WHERE id = @p1 AND status = @p2")
      ).toBe(2);
      expect(
        countParameters(
          "SELECT * FROM users WHERE id = @p1 AND status = @p2 AND role = @p3"
        )
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
      // Non-sequential: $2, $5, $7 (missing $1, $3, $4, $6) should throw
      expect(() => countParameters("SELECT * WHERE a = $2 AND b = $5 AND c = $7")).toThrow(
        /Non-sequential numbered parameters.*missing \$1/
      );
      // Starting from $2 instead of $1 should throw
      expect(() => countParameters("SELECT * WHERE a = $2")).toThrow(
        /Non-sequential numbered parameters.*missing \$1/
      );
    });

    it("should allow reused numbered parameters", () => {
      // Reused $1 should count as 1 parameter (valid)
      expect(countParameters("SELECT * WHERE id = $1 OR parent_id = $1")).toBe(1);
      // Reused $1 and sequential $2 should count as 2 parameters (valid)
      expect(countParameters("SELECT * WHERE (id = $1 OR parent_id = $1) AND status = $2")).toBe(2);
      // Reused $1 and $2 with sequential $3 should count as 3 parameters (valid)
      expect(countParameters("SELECT * WHERE (id = $1 OR parent_id = $1) AND (status = $2 OR type = $2) LIMIT $3")).toBe(3);
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
      const params: ParameterConfig[] = [
        {
          name: "id",
          type: "integer",
          description: "User ID",
        },
        {
          name: "status",
          type: "string",
          description: "User status",
        },
      ];
      expect(() => validateParameters(sql, params, "postgres")).not.toThrow();
    });

    it("should reject mismatched parameter count", () => {
      const sql = "SELECT * FROM users WHERE id = $1";
      const params: ParameterConfig[] = [
        {
          name: "id",
          type: "integer",
          description: "User ID",
        },
        {
          name: "status",
          type: "string",
          description: "User status",
        },
      ];
      expect(() => validateParameters(sql, params, "postgres")).toThrow(
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
      const params: ParameterConfig[] = [
        { name: "id", type: "integer", description: "User ID" },
        { name: "status", type: "string", description: "User status" },
      ];
      const args = { id: 123, status: "active" };
      const result = mapArgumentsToArray(params, args);
      expect(result).toEqual([123, "active"]);
    });

    it("should use default values for missing optional parameters", () => {
      const params: ParameterConfig[] = [
        { name: "id", type: "integer", description: "User ID" },
        {
          name: "status",
          type: "string",
          description: "User status",
          default: "pending",
        },
      ];
      const args = { id: 123 };
      const result = mapArgumentsToArray(params, args);
      expect(result).toEqual([123, "pending"]);
    });

    it("should use provided values over defaults", () => {
      const params: ParameterConfig[] = [
        { name: "id", type: "integer", description: "User ID" },
        {
          name: "status",
          type: "string",
          description: "User status",
          default: "pending",
        },
      ];
      const args = { id: 123, status: "active" };
      const result = mapArgumentsToArray(params, args);
      expect(result).toEqual([123, "active"]);
    });

    it("should throw for missing required parameters without defaults", () => {
      const params: ParameterConfig[] = [
        { name: "id", type: "integer", description: "User ID" },
        { name: "status", type: "string", description: "User status" },
      ];
      const args = { id: 123 };
      expect(() => mapArgumentsToArray(params, args)).toThrow(
        /Required parameter 'status' is missing/
      );
    });

    it("should handle empty parameters array", () => {
      const result = mapArgumentsToArray([], {});
      expect(result).toEqual([]);
    });

    it("should handle undefined parameters", () => {
      const result = mapArgumentsToArray(undefined, {});
      expect(result).toEqual([]);
    });

    it("should use null for optional parameters without default", () => {
      const params: ParameterConfig[] = [
        { name: "id", type: "integer", description: "User ID" },
        {
          name: "status",
          type: "string",
          description: "User status",
          required: false,
        },
      ];
      const args = { id: 123 };
      const result = mapArgumentsToArray(params, args);
      expect(result).toEqual([123, null]);
    });
  });
});
