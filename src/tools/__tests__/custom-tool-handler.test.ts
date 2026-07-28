import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import {
  buildZodSchemaFromParameters,
  buildInputSchema,
  createCustomToolHandler,
} from "../custom-tool-handler.js";
import { ConnectorManager } from "../../connectors/manager.js";
import type { ToolConfig, ParameterConfig } from "../../types/config.js";
import { requestStore } from "../../requests/index.js";
import { SafeExecutionError } from "../../utils/safe-execution-error.js";

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
      requestStore.clear();
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
      expect(payload.details).toBeUndefined();
      // Connection failures must NOT be augmented with SQL-context debugging info
      expect(payload.error).not.toContain("SQL:");
      expect(payload.error).not.toContain(toolConfig.source);
      expect(requestStore.getAll("prod")[0]?.error).toBe(
        `SOURCE_UNREACHABLE: ${payload.error}`
      );
    });

    it("uses the same safe guardrail view as execute_sql", async () => {
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);
      vi.mocked(ConnectorManager.getCurrentConnector).mockReturnValue({
        id: "mysql",
        getId: () => "prod",
        executeSQL: vi.fn().mockRejectedValue(
          new SafeExecutionError("MYSQL_READONLY_GUARDRAIL", "dangerous_function", {
            cause: new Error("RAW_CAUSE_SENTINEL"),
          })
        ),
      } as any);

      const toolConfig: ToolConfig = {
        name: "dangerous_tool",
        source: "prod",
        description: "test",
        statement: "SELECT SLEEP(1)",
        readonly: true,
      } as any;
      const handler = createCustomToolHandler(toolConfig);
      const res: any = await handler({}, {});
      const payload = JSON.parse(res.content[0].text);

      expect(payload).toMatchObject({
        code: "MYSQL_READONLY_GUARDRAIL",
        error: "MySQL read-only guardrail rejected the query.",
      });
      expect(JSON.stringify(payload)).not.toContain("RAW_CAUSE_SENTINEL");
      expect(requestStore.getAll("prod")[0]?.error).toBe(
        "MYSQL_READONLY_GUARDRAIL: MySQL read-only guardrail rejected the query."
      );
    });

    it("maps safety precondition errors to the frozen custom-tool view", async () => {
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);
      vi.mocked(ConnectorManager.getCurrentConnector).mockReturnValue({
        id: "mysql",
        getId: () => "prod",
        executeSQL: vi.fn().mockRejectedValue(
          new SafeExecutionError(
            "MYSQL_SAFETY_CHECK_FAILED",
            "statement_plan_unsupported",
            { cause: new Error("RAW_PLAN_SENTINEL") }
          )
        ),
      } as any);
      const toolConfig: ToolConfig = {
        name: "safe_plan_tool",
        source: "prod",
        description: "test",
        statement: "SELECT 1",
        readonly: true,
      } as any;

      const response: any = await createCustomToolHandler(toolConfig)({}, {});
      const payload = JSON.parse(response.content[0].text);

      expect(payload).toMatchObject({
        code: "MYSQL_SAFETY_CHECK_FAILED",
        error: "MySQL safety precondition failed.",
      });
      expect(JSON.stringify(payload)).not.toContain("RAW_PLAN_SENTINEL");
      expect(requestStore.getAll("prod")[0]?.error).toBe(
        "MYSQL_SAFETY_CHECK_FAILED: MySQL safety precondition failed."
      );
    });

    it("uses the frozen readonly violation view and request-store format", async () => {
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);
      const executeSQL = vi.fn();
      vi.mocked(ConnectorManager.getCurrentConnector).mockReturnValue({
        id: "mysql",
        getId: () => "SOURCE_SENTINEL",
        executeSQL,
      } as any);
      const toolConfig: ToolConfig = {
        name: "TOOL_SENTINEL",
        source: "SOURCE_SENTINEL",
        description: "test",
        statement: "DELETE FROM users",
        readonly: true,
      } as any;

      const response: any = await createCustomToolHandler(toolConfig)({}, {});
      const payload = JSON.parse(response.content[0].text);

      expect(payload).toEqual({
        success: false,
        error:
          "The tool cannot execute this statement in readonly mode. Only read-only SQL operations are allowed.",
        code: "READONLY_VIOLATION",
      });
      expect(executeSQL).not.toHaveBeenCalled();
      expect(requestStore.getAll("SOURCE_SENTINEL")[0]?.error).toBe(
        "READONLY_VIOLATION: The tool cannot execute this statement in readonly mode. Only read-only SQL operations are allowed."
      );
      expect(JSON.stringify(payload)).not.toContain("SOURCE_SENTINEL");
      expect(JSON.stringify(payload)).not.toContain("TOOL_SENTINEL");
    });

    it.each([
      ["stacked DDL", "SELECT 1; DROP TABLE users"],
      ["stacked DML", "SELECT 1; INSERT INTO users (id) VALUES (1)"],
      ["server file write", "SELECT 1 INTO OUTFILE '/tmp/dbhub-guardrail'"],
    ])("rejects %s before a readonly custom tool reaches the connector", async (_, statement) => {
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);
      const executeSQL = vi.fn();
      vi.mocked(ConnectorManager.getCurrentConnector).mockReturnValue({
        id: "mysql",
        getId: () => "prod",
        executeSQL,
      } as any);
      const toolConfig: ToolConfig = {
        name: "readonly_batch",
        source: "prod",
        description: "test",
        statement,
        readonly: true,
      } as any;

      const response: any = await createCustomToolHandler(toolConfig)({}, {});
      const payload = JSON.parse(response.content[0].text);

      expect(payload.code).toBe("READONLY_VIOLATION");
      expect(executeSQL).not.toHaveBeenCalled();
      expect(requestStore.getAll("prod")[0]?.error).toBe(
        `READONLY_VIOLATION: ${payload.error}`
      );
    });

    it("does not expose parameter names, SQL, values, or raw database errors", async () => {
      const parameterSentinel = "secret_parameter_name";
      const sqlSentinel = "RAW_SQL_SENTINEL";
      const valueSentinel = "RAW_VALUE_SENTINEL";

      const validationConfig: ToolConfig = {
        name: "validation_tool",
        source: "prod",
        description: "test",
        statement: "SELECT 1",
        parameters: [
          {
            name: parameterSentinel,
            type: "integer",
            description: "secret",
          },
        ],
      } as any;
      const validationResponse: any = await createCustomToolHandler(validationConfig)(
        { [parameterSentinel]: "wrong" },
        {}
      );
      const validationPayload = JSON.parse(validationResponse.content[0].text);
      expect(validationPayload).toMatchObject({
        code: "EXECUTION_ERROR",
        error: "Parameter validation failed.",
      });
      expect(JSON.stringify(validationPayload)).not.toContain(parameterSentinel);
      expect(requestStore.getAll("prod")[0]?.error).toBe(
        "EXECUTION_ERROR: Parameter validation failed."
      );

      requestStore.clear();
      vi.mocked(ConnectorManager.ensureConnected).mockResolvedValue(undefined as any);
      vi.mocked(ConnectorManager.getCurrentConnector).mockReturnValue({
        id: "mysql",
        getId: () => "prod",
        executeSQL: vi.fn().mockRejectedValue(new Error("RAW_DB_SENTINEL")),
      } as any);
      const executionConfig: ToolConfig = {
        name: "execution_tool",
        source: "prod",
        description: "test",
        statement: `SELECT ? /* ${sqlSentinel} */`,
        parameters: [
          { name: "value", type: "string", description: "value" },
        ],
      } as any;
      const executionResponse: any = await createCustomToolHandler(executionConfig)(
        { value: valueSentinel },
        {}
      );
      const serialized = executionResponse.content[0].text;
      expect(JSON.parse(serialized)).toMatchObject({
        code: "EXECUTION_ERROR",
        error: "Database query execution failed.",
      });
      expect(serialized).not.toContain(sqlSentinel);
      expect(serialized).not.toContain(valueSentinel);
      expect(serialized).not.toContain("RAW_DB_SENTINEL");
      expect(requestStore.getAll("prod")[0]?.error).toBe(
        "EXECUTION_ERROR: Database query execution failed."
      );
    });
  });
});
