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
      ["SELECT * FROM users WHERE id = {p1:UInt64}", "clickhouse"],
      // `?` and `:` are the conditional operator in ClickHouse, not placeholders
      ["SELECT x > 0 ? 1 : 2 FROM t", "clickhouse"],
      // SQL without parameters is valid for any connector: the style check
      // returns before the connector is consulted
      ["SELECT * FROM users", "postgres"],
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

  describe("ClickHouse {pN:Type} placeholders", () => {
    it("should count placeholders by their highest index, whatever the type", () => {
      const sql =
        "SELECT * FROM events WHERE tenant = {p1:String} AND day >= {p2 : Date} " +
        "AND id IN {p3:Array(UInt32)} AND owner = {p1:String}";
      expect(detectParameterStyle(sql, "clickhouse")).toBe("braced");
      expect(countParameters(sql, "clickhouse")).toBe(3);
    });

    it("should ignore placeholders inside strings and comments, and other dialects' styles", () => {
      const sql = "SELECT '{p2:String}', a ? b : 1 /* {p3:String} */ FROM t WHERE id = {p1:UInt64} -- $1 @p1";
      expect(countParameters(sql, "clickhouse")).toBe(1);
    });

    it("should not read a map literal or a named placeholder as a positional one", () => {
      expect(detectParameterStyle("SELECT {'p1': 1} AS m, {tenant:String} AS t", "clickhouse")).toBe("none");
    });

    it("should require placeholders to be sequential from p1", () => {
      expect(() => countParameters("SELECT {p2:String}", "clickhouse")).toThrow(/missing \{p1/);
      expect(() => countParameters("SELECT {p0:String}", "clickhouse")).toThrow(/parameter \{p0/);
    });

    it("should validate the placeholder count against the tool's parameters", () => {
      const parameters = [{ name: "tenant", type: "string" as const, description: "tenant" }];
      expect(() =>
        validateParameters("SELECT * FROM t WHERE tenant = {p1:String}", parameters, "clickhouse")
      ).not.toThrow();
      // A `?` is not a placeholder here, so the statement has none to bind.
      expect(() => validateParameters("SELECT * FROM t WHERE tenant = ?", parameters, "clickhouse")).toThrow(
        /SQL statement has 0 parameter\(s\), but 1 parameter\(s\) defined/
      );
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

    // The three indexed styles share one rule: placeholders must run from 1
    // without gaps, and a reused placeholder counts once.
    it.each([
      // [style as named in the error, sigil]
      ["numbered", "$"],
      ["named", "@p"],
      ["colon-numbered", ":"],
    ])("should require %s parameters to be sequential from 1, counting a reused one once", (style, s) => {
      expect(countParameters(`SELECT * WHERE id = ${s}1 OR parent_id = ${s}1`)).toBe(1);
      expect(countParameters(`SELECT * WHERE (id = ${s}1 OR parent_id = ${s}1) AND status = ${s}2`)).toBe(2);
      // A gap: 1, 3 (missing 2)
      expect(() => countParameters(`SELECT * WHERE a = ${s}1 AND b = ${s}3`)).toThrow(
        `Non-sequential ${style} parameters detected. Found placeholders: ${s}1, ${s}3. ` +
          `Parameters must be sequential starting from ${s}1 (missing ${s}2).`
      );
      // Not starting from 1: 2, 5, 7
      expect(() => countParameters(`SELECT * WHERE a = ${s}2 AND b = ${s}5 AND c = ${s}7`)).toThrow(
        `Non-sequential ${style} parameters detected. Found placeholders: ${s}2, ${s}5, ${s}7. ` +
          `Parameters must be sequential starting from ${s}1 (missing ${s}1).`
      );
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
