import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import {
  buildZodSchemaFromParameters,
  buildInputSchema,
  createCustomToolHandler,
} from "../custom-tool-handler.js";
import { ConnectorManager } from "../../connectors/manager.js";
import type { ToolConfig, ParameterConfig } from "../../types/config.js";

// Auto-mock the connector manager so we control connection/execution behavior
vi.mock("../../connectors/manager.js");

const param = (
  name: string,
  type: ParameterConfig["type"],
  extra: Partial<ParameterConfig> = {}
): ParameterConfig => ({ name, type, description: `${name} value`, ...extra });

const zodSchemaFor = (params: ParameterConfig[] | undefined) =>
  z.object(buildZodSchemaFromParameters(params));

describe("Custom Tool Handler", () => {
  describe("buildZodSchemaFromParameters", () => {
    it("should require a parameter without default or required=false", () => {
      const schema = zodSchemaFor([param("email", "string")]);
      expect(schema.safeParse({ email: "test@example.com" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
    });

    it.each([
      // [type, valid values, invalid values]
      ["integer", [123], [123.45 /* not an integer */, "123" /* wrong type */]],
      ["float", [123.45, 123 /* integers are valid floats */], ["123.45" /* wrong type */]],
      ["boolean", [true, false], ["true" /* wrong type */]],
      [
        "array",
        [[], [1, 2, 3], ["a", "b"]],
        ["not-array"],
      ],
    ] as const)("should build schema with %s parameter", (type, validValues, invalidValues) => {
      const schema = zodSchemaFor([param("value", type)]);

      for (const value of validValues) {
        expect(schema.safeParse({ value }).success).toBe(true);
      }
      for (const value of invalidValues) {
        expect(schema.safeParse({ value }).success).toBe(false);
      }
    });

    it.each([
      ["has default", { default: "pending" }],
      ["required=false", { required: false }],
    ])("should build schema with optional parameter (%s)", (_, extra) => {
      const schema = zodSchemaFor([param("status", "string", extra)]);

      expect(schema.safeParse({}).success).toBe(true); // Optional, so missing is ok
      expect(schema.safeParse({ status: "active" }).success).toBe(true);
    });

    it("should build schema with allowed_values for string", () => {
      const schema = zodSchemaFor([
        param("status", "string", { allowed_values: ["pending", "active", "completed"] }),
      ]);

      expect(schema.safeParse({ status: "pending" }).success).toBe(true);
      expect(schema.safeParse({ status: "active" }).success).toBe(true);
      expect(schema.safeParse({ status: "invalid" }).success).toBe(false);
    });

    it("should build schema with allowed_values for integer", () => {
      const schema = zodSchemaFor([param("priority", "integer", { allowed_values: [1, 2, 3] })]);

      expect(schema.safeParse({ priority: 1 }).success).toBe(true);
      expect(schema.safeParse({ priority: 2 }).success).toBe(true);
      expect(schema.safeParse({ priority: 4 }).success).toBe(false);
    });

    it.each([
      ["undefined parameters", undefined],
      ["empty parameters array", []],
    ])("should build empty schema for %s", (_, params) => {
      const schema = zodSchemaFor(params);
      expect(schema.safeParse({}).success).toBe(true);
    });
  });

  describe("buildInputSchema", () => {
    it("should build JSON Schema for string parameter", () => {
      const schema = buildInputSchema([param("email", "string", { description: "User email" })]);

      expect(schema.type).toBe("object");
      expect(schema.properties.email).toEqual({
        type: "string",
        description: "User email",
      });
      expect(schema.required).toEqual(["email"]);
    });

    it.each([
      // [parameter type, expected JSON Schema type]
      ["integer", "integer"],
      ["float", "number"],
      ["boolean", "boolean"],
      ["array", "array"],
    ] as const)("should build JSON Schema for %s parameter", (paramType, jsonType) => {
      const schema = buildInputSchema([param("value", paramType)]);

      expect(schema.properties.value.type).toBe(jsonType);
    });

    it("should include enum for allowed_values", () => {
      const schema = buildInputSchema([
        param("status", "string", { allowed_values: ["pending", "active"] }),
      ]);

      expect(schema.properties.status.enum).toEqual(["pending", "active"]);
    });

    it("should not include optional params in required array", () => {
      const schema = buildInputSchema([
        param("id", "integer"),
        param("status", "string", { required: false }),
        param("priority", "integer", { default: 1 }),
      ]);

      expect(schema.required).toEqual(["id"]);
    });

    it("should omit required field when all params are optional", () => {
      const schema = buildInputSchema([param("status", "string", { default: "pending" })]);

      expect(schema.required).toBeUndefined();
    });

    it("should build empty schema for undefined parameters", () => {
      const schema = buildInputSchema(undefined);

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({});
      expect(schema.required).toBeUndefined();
    });
  });

  describe("createCustomToolHandler connection error classification", () => {
    afterEach(() => {
      vi.clearAllMocks();
    });

    it("returns SOURCE_UNREACHABLE (not a SQL error) when the connector throws a network error", async () => {
      const econn: any = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      econn.code = "ECONNREFUSED";

      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);
      vi.mocked(ConnectorManager.getCurrentConnector).mockReturnValue({
        id: "postgres",
        getId: () => "prod",
        executeSQL: vi.fn().mockRejectedValue(econn),
      } as any);
      vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({
        id: "prod",
        type: "postgres",
      } as any);

      const toolConfig: ToolConfig = {
        name: "get_user",
        source: "prod",
        statement: "SELECT * FROM users",
      } as any;

      const handler = createCustomToolHandler(toolConfig);
      const res: any = await handler({}, {});
      const payload = JSON.parse(res.content[0].text);

      expect(res.isError).toBe(true);
      expect(payload.code).toBe("SOURCE_UNREACHABLE");
      expect(payload.details.source_id).toBe(toolConfig.source);
      // Connection failures must NOT be augmented with SQL-context debugging info
      expect(payload.error).not.toContain("SQL:");
    });
  });
});
