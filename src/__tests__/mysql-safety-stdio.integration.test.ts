import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import mysql from "mysql2/promise";

const DATABASE = "testdb";
const ROOT_PASSWORD = "rootpass";
const READONLY_USER = "dbhub_readonly";
const READONLY_PASSWORD = "readonlypass";
const PRIVILEGED_SOURCE_ID = "PRIVILEGED_SOURCE_SENTINEL";
const PRIVILEGED_DDL_TARGET = "PRIVILEGED_DDL_SENTINEL";

function connectionUri(
  container: StartedMySqlContainer,
  username: string,
  password: string
): string {
  return `mysql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${container.getHost()}:${container.getPort()}/${DATABASE}`;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: any;
}

describe.each(["mysql:8.0.36", "mysql:9.7.1"])("MySQL safety stdio integration (%s)", (image) => {
  let container: StartedMySqlContainer;
  let child: ChildProcessWithoutNullStreams;
  let isolatedCwd: string;
  let configPath: string;
  let executeToolName: string;
  let privilegedExecuteToolName: string;
  let stderr = "";
  let nextId = 1;
  let stdoutBuffer = "";
  const pending = new Map<
    number,
    { resolve: (response: JsonRpcResponse) => void; reject: (error: Error) => void }
  >();

  function send(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = nextId++;
    const request = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  function notify(method: string, params?: unknown): void {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`
    );
  }

  function toolPayload(response: JsonRpcResponse): any {
    expect(response.error).toBeUndefined();
    const text = response.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");
    return JSON.parse(text);
  }

  beforeAll(async () => {
    container = await new MySqlContainer(image)
      .withDatabase(DATABASE)
      .withRootPassword(ROOT_PASSWORD)
      .start();

    const setupConnection = await mysql.createConnection(
      connectionUri(container, "root", ROOT_PASSWORD)
    );
    try {
      await setupConnection.query(
        `CREATE USER '${READONLY_USER}'@'%' IDENTIFIED BY '${READONLY_PASSWORD}'`
      );
      await setupConnection.query(`GRANT SELECT ON \`${DATABASE}\`.* TO '${READONLY_USER}'@'%'`);
      await setupConnection.query(`CREATE TABLE \`${PRIVILEGED_DDL_TARGET}\` (id INT PRIMARY KEY)`);
    } finally {
      await setupConnection.end();
    }

    isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "dbhub-mysql-stdio-"));
    configPath = path.join(isolatedCwd, "dbhub.toml");
    const sourceId = "SOURCE_ID_SENTINEL";
    const customToolName = "CUSTOM_TOOL_SENTINEL";
    const parameterName = "PARAMETER_SCHEMA_SENTINEL";
    fs.writeFileSync(
      configPath,
      [
        "[[sources]]",
        `id = ${JSON.stringify(sourceId)}`,
        `dsn = ${JSON.stringify(connectionUri(container, READONLY_USER, READONLY_PASSWORD))}`,
        "",
        "[[sources]]",
        `id = ${JSON.stringify(PRIVILEGED_SOURCE_ID)}`,
        `dsn = ${JSON.stringify(connectionUri(container, "root", ROOT_PASSWORD))}`,
        "",
        "[[tools]]",
        'name = "execute_sql"',
        `source = ${JSON.stringify(sourceId)}`,
        "readonly = true",
        "",
        "[[tools]]",
        'name = "execute_sql"',
        `source = ${JSON.stringify(PRIVILEGED_SOURCE_ID)}`,
        "readonly = true",
        "",
        "[[tools]]",
        `name = ${JSON.stringify(customToolName)}`,
        `source = ${JSON.stringify(sourceId)}`,
        'description = "Guardrail sentinel tool"',
        'statement = "SELECT SLEEP(?) /* RAW_SQL_SENTINEL */"',
        "readonly = true",
        "",
        "[[tools.parameters]]",
        `name = ${JSON.stringify(parameterName)}`,
        'type = "string"',
        'description = "sentinel"',
      ].join("\n")
    );

    const tsxCli = path.resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const entry = path.resolve(process.cwd(), "src", "index.ts");
    child = spawn(process.execPath, [tsxCli, entry, `--config=${configPath}`], {
      cwd: isolatedCwd,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: "pipe",
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      while (true) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline === -1) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        const response = JSON.parse(line) as JsonRpcResponse;
        if (typeof response.id !== "number") continue;
        const waiter = pending.get(response.id);
        if (!waiter) continue;
        pending.delete(response.id);
        waiter.resolve(response);
      }
    });
    child.on("exit", (code) => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error(`DBHub stdio child exited with code ${code}. stderr: ${stderr}`));
      }
      pending.clear();
    });

    const initialize = await send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "dbhub-safety-test", version: "1.0.0" },
    });
    expect(initialize.result?.serverInfo).toBeDefined();
    notify("notifications/initialized");
    const listed = await send("tools/list");
    const names = listed.result?.tools?.map((tool: { name: string }) => tool.name) ?? [];
    executeToolName = names.find((name: string) => name === `execute_sql_${sourceId}`)!;
    privilegedExecuteToolName = names.find(
      (name: string) => name === `execute_sql_${PRIVILEGED_SOURCE_ID}`
    )!;
    expect(executeToolName).toBeTruthy();
    expect(privilegedExecuteToolName).toBeTruthy();
    expect(names).toContain(customToolName);
    stderr = "";
  }, 180_000);

  afterAll(async () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
            resolve();
          }, 5_000);
          child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    } finally {
      try {
        if (isolatedCwd) {
          fs.rmSync(isolatedCwd, { recursive: true, force: true });
        }
      } finally {
        await container?.stop();
      }
    }
  }, 60_000);

  it("runs initialize, tools/list, ordinary SQL, and safe builtin/custom failures", async () => {
    const ordinary = toolPayload(
      await send("tools/call", {
        name: executeToolName,
        arguments: { sql: "SELECT 1 AS value" },
      })
    );
    expect(ordinary).toMatchObject({ success: true, data: { rows: [{ value: 1 }] } });

    const builtinGuardrail = toolPayload(
      await send("tools/call", {
        name: executeToolName,
        arguments: { sql: "SELECT SLEEP(1) /* BUILTIN_SQL_SENTINEL */" },
      })
    );
    expect(builtinGuardrail).toMatchObject({
      success: false,
      code: "MYSQL_READONLY_GUARDRAIL",
      error: "MySQL read-only guardrail rejected the query.",
    });

    const customGuardrail = toolPayload(
      await send("tools/call", {
        name: "CUSTOM_TOOL_SENTINEL",
        arguments: { PARAMETER_SCHEMA_SENTINEL: "RAW_PARAMETER_SENTINEL" },
      })
    );
    expect(customGuardrail).toMatchObject({
      success: false,
      code: "MYSQL_READONLY_GUARDRAIL",
      error: "MySQL read-only guardrail rejected the query.",
    });

    const genericFailure = toolPayload(
      await send("tools/call", {
        name: executeToolName,
        arguments: { sql: "SELECT * FROM RAW_DATABASE_ERROR_SENTINEL" },
      })
    );
    expect(genericFailure).toMatchObject({
      success: false,
      code: "EXECUTION_ERROR",
      error: "Database query execution failed.",
    });

    const privilegedPrecheck = toolPayload(
      await send("tools/call", {
        name: privilegedExecuteToolName,
        arguments: {
          sql: `SELECT 1 -- comment\r; DROP TABLE ${PRIVILEGED_DDL_TARGET}`,
        },
      })
    );
    expect(privilegedPrecheck).toMatchObject({
      success: false,
      code: "READONLY_VIOLATION",
      error:
        "The tool cannot execute this statement in readonly mode. Only read-only SQL operations are allowed.",
    });

    const observer = await mysql.createConnection(connectionUri(container, "root", ROOT_PASSWORD));
    try {
      const [rows] = await observer.query("SHOW TABLES LIKE ?", [PRIVILEGED_DDL_TARGET]);
      expect(rows).toHaveLength(1);
    } finally {
      await observer.end();
    }

    const serializedErrors = JSON.stringify([
      builtinGuardrail,
      customGuardrail,
      genericFailure,
      privilegedPrecheck,
    ]);
    for (const sentinel of [
      "SOURCE_ID_SENTINEL",
      "CUSTOM_TOOL_SENTINEL",
      "PARAMETER_SCHEMA_SENTINEL",
      "RAW_SQL_SENTINEL",
      "RAW_PARAMETER_SENTINEL",
      "BUILTIN_SQL_SENTINEL",
      "RAW_DATABASE_ERROR_SENTINEL",
      PRIVILEGED_SOURCE_ID,
      PRIVILEGED_DDL_TARGET,
    ]) {
      expect(serializedErrors).not.toContain(sentinel);
      expect(stderr).not.toContain(sentinel);
    }
    expect(stderr).not.toContain(container.getConnectionUri());
  });
});
