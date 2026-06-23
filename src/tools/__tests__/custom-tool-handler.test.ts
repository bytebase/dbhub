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

describe("Custom Tool Handler", () => {
  describe("buildZodSchemaFromParameters", () => {
    it("should build schema with required string parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "email",
          type: "string",
          description: "User email address",
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);
      const result = schema.safeParse({ email: "test@example.com" });
      expect(result.success).toBe(true);
    });

    it("should reject missing required parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "email",
          type: "string",
          description: "User email address",
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);
      const result = schema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("should build schema with integer parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "user_id",
          type: "integer",
          description: "User ID",
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);

      expect(schema.safeParse({ user_id: 123 }).success).toBe(true);
      expect(schema.safeParse({ user_id: 123.45 }).success).toBe(false); // Not an integer
      expect(schema.safeParse({ user_id: "123" }).success).toBe(false); // Wrong type
    });

    it("should build schema with float parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "amount",
          type: "float",
          description: "Amount",
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);

      expect(schema.safeParse({ amount: 123.45 }).success).toBe(true);
      expect(schema.safeParse({ amount: 123 }).success).toBe(true); // Integers are valid floats
      expect(schema.safeParse({ amount: "123.45" }).success).toBe(false); // Wrong type
    });

    it("should build schema with boolean parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "active",
          type: "boolean",
          description: "Is active",
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);

      expect(schema.safeParse({ active: true }).success).toBe(true);
      expect(schema.safeParse({ active: false }).success).toBe(true);
      expect(schema.safeParse({ active: "true" }).success).toBe(false); // Wrong type
    });

    it("should build schema with array parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "tags",
          type: "array",
          description: "Tags",
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);

      expect(schema.safeParse({ tags: [] }).success).toBe(true);
      expect(schema.safeParse({ tags: [1, 2, 3] }).success).toBe(true);
      expect(schema.safeParse({ tags: ["a", "b"] }).success).toBe(true);
      expect(schema.safeParse({ tags: "not-array" }).success).toBe(false);
    });

    it("should build schema with optional parameter (has default)", () => {
      const params: ParameterConfig[] = [
        {
          name: "status",
          type: "string",
          description: "Status",
          default: "pending",
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);

      expect(schema.safeParse({}).success).toBe(true); // Optional, so missing is ok
      expect(schema.safeParse({ status: "active" }).success).toBe(true);
    });

    it("should build schema with optional parameter (required=false)", () => {
      const params: ParameterConfig[] = [
        {
          name: "status",
          type: "string",
          description: "Status",
          required: false,
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);

      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ status: "active" }).success).toBe(true);
    });

    it("should build schema with allowed_values for string", () => {
      const params: ParameterConfig[] = [
        {
          name: "status",
          type: "string",
          description: "Status",
          allowed_values: ["pending", "active", "completed"],
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);

      expect(schema.safeParse({ status: "pending" }).success).toBe(true);
      expect(schema.safeParse({ status: "active" }).success).toBe(true);
      expect(schema.safeParse({ status: "invalid" }).success).toBe(false);
    });

    it("should build schema with allowed_values for integer", () => {
      const params: ParameterConfig[] = [
        {
          name: "priority",
          type: "integer",
          description: "Priority level",
          allowed_values: [1, 2, 3],
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);

      expect(schema.safeParse({ priority: 1 }).success).toBe(true);
      expect(schema.safeParse({ priority: 2 }).success).toBe(true);
      expect(schema.safeParse({ priority: 4 }).success).toBe(false);
    });

    it("should build schema with multiple parameters", () => {
      const params: ParameterConfig[] = [
        {
          name: "id",
          type: "integer",
          description: "User ID",
        },
        {
          name: "email",
          type: "string",
          description: "Email",
        },
        {
          name: "active",
          type: "boolean",
          description: "Is active",
          default: true,
        },
      ];
      const schemaShape = buildZodSchemaFromParameters(params);
      const schema = z.object(schemaShape);

      expect(
        schema.safeParse({
          id: 123,
          email: "test@example.com",
        }).success
      ).toBe(true);

      expect(
        schema.safeParse({
          id: 123,
          email: "test@example.com",
          active: false,
        }).success
      ).toBe(true);

      expect(
        schema.safeParse({
          id: 123,
          // missing required email
        }).success
      ).toBe(false);
    });

    it("should build empty schema for undefined parameters", () => {
      const schemaShape = buildZodSchemaFromParameters(undefined);
      const schema = z.object(schemaShape);
      expect(schema.safeParse({}).success).toBe(true);
    });

    it("should build empty schema for empty parameters array", () => {
      const schemaShape = buildZodSchemaFromParameters([]);
      const schema = z.object(schemaShape);
      expect(schema.safeParse({}).success).toBe(true);
    });
  });

  describe("buildInputSchema", () => {
    it("should build JSON Schema for string parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "email",
          type: "string",
          description: "User email",
        },
      ];
      const schema = buildInputSchema(params);

      expect(schema.type).toBe("object");
      expect(schema.properties.email).toEqual({
        type: "string",
        description: "User email",
      });
      expect(schema.required).toEqual(["email"]);
    });

    it("should build JSON Schema for integer parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "count",
          type: "integer",
          description: "Count",
        },
      ];
      const schema = buildInputSchema(params);

      expect(schema.properties.count.type).toBe("integer");
    });

    it("should build JSON Schema for float parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "amount",
          type: "float",
          description: "Amount",
        },
      ];
      const schema = buildInputSchema(params);

      expect(schema.properties.amount.type).toBe("number");
    });

    it("should build JSON Schema for boolean parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "active",
          type: "boolean",
          description: "Active flag",
        },
      ];
      const schema = buildInputSchema(params);

      expect(schema.properties.active.type).toBe("boolean");
    });

    it("should build JSON Schema for array parameter", () => {
      const params: ParameterConfig[] = [
        {
          name: "tags",
          type: "array",
          description: "Tags",
        },
      ];
      const schema = buildInputSchema(params);

      expect(schema.properties.tags.type).toBe("array");
    });

    it("should include enum for allowed_values", () => {
      const params: ParameterConfig[] = [
        {
          name: "status",
          type: "string",
          description: "Status",
          allowed_values: ["pending", "active"],
        },
      ];
      const schema = buildInputSchema(params);

      expect(schema.properties.status.enum).toEqual(["pending", "active"]);
    });

    it("should not include optional params in required array", () => {
      const params: ParameterConfig[] = [
        {
          name: "id",
          type: "integer",
          description: "ID",
        },
        {
          name: "status",
          type: "string",
          description: "Status",
          required: false,
        },
        {
          name: "priority",
          type: "integer",
          description: "Priority",
          default: 1,
        },
      ];
      const schema = buildInputSchema(params);

      expect(schema.required).toEqual(["id"]);
    });

    it("should omit required field when all params are optional", () => {
      const params: ParameterConfig[] = [
        {
          name: "status",
          type: "string",
          description: "Status",
          default: "pending",
        },
      ];
      const schema = buildInputSchema(params);

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
