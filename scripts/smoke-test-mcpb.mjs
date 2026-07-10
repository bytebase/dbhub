#!/usr/bin/env node

// Smoke test for the packed MCP Bundle (dist-mcpb/dbhub-<version>.mcpb).
//
// The bundle is unpacked into an OS temp directory OUTSIDE the repository —
// this is essential: inside the repo, Node module resolution would walk up
// into the project's own node_modules and mask missing packages in the
// bundle. The unpacked server is then driven over stdio with the MCP SDK
// client, exactly as an MCPB client (e.g. Claude Desktop) would:
//   - launches `node server/index.js --transport stdio --config dbhub.toml`
//     with the DSN injected via the DBHUB_DSN env var (in-memory SQLite)
//   - all five connectors must load (drivers resolve from the bundle)
//   - tools/list must expose exactly execute_sql and search_objects
//   - execute_sql SELECT succeeds
//   - execute_sql CREATE TABLE is rejected (the bundle config is read-only)
//
// Run after `pnpm run build:mcpb`: pnpm run test:mcpb

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcpbFile, localBin } from "./mcpb-common.mjs";

if (!existsSync(mcpbFile)) {
  console.error(`Packed bundle ${mcpbFile} not found — run \`pnpm run build:mcpb\` first.`);
  process.exit(1);
}

const bundleDir = mkdtempSync(join(tmpdir(), "dbhub-mcpb-smoke-"));
process.on("exit", () => rmSync(bundleDir, { recursive: true, force: true }));

const unpack = spawnSync(localBin("mcpb"), ["unpack", mcpbFile, bundleDir], { stdio: "inherit" });
if (unpack.status !== 0) {
  console.error(`mcpb unpack failed${unpack.error ? `: ${unpack.error.message}` : ""}`);
  process.exit(1);
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  OK  ${name}`);
  } else {
    console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
    failures++;
  }
}

function resultText(result) {
  return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

const client = new Client({ name: "mcpb-smoke-test", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    join(bundleDir, "server", "index.js"),
    "--transport",
    "stdio",
    "--config",
    join(bundleDir, "dbhub.toml"),
  ],
  cwd: bundleDir,
  env: { ...process.env, DBHUB_DSN: "sqlite:///:memory:" },
  stderr: "pipe",
});

// With stderr: "pipe" the transport exposes a PassThrough stream before the
// process is spawned — attach before connect() so startup output (including
// a startup crash) is always captured.
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await client.connect(transport);
  check("initialize", client.getServerVersion()?.name !== undefined);

  const { tools } = await client.listTools();
  const toolNames = tools.map((tool) => tool.name).sort();
  check(
    "tools/list exposes exactly execute_sql + search_objects",
    JSON.stringify(toolNames) === JSON.stringify(["execute_sql", "search_objects"]),
    `got: ${toolNames.join(", ")}`
  );

  const select = await client.callTool({
    name: "execute_sql",
    arguments: { sql: "SELECT 1 AS one" },
  });
  check(
    "execute_sql SELECT succeeds",
    !select.isError && resultText(select).includes("one"),
    resultText(select)
  );

  const create = await client.callTool({
    name: "execute_sql",
    arguments: { sql: "CREATE TABLE smoke_test (id INTEGER)" },
  });
  check(
    "execute_sql CREATE is rejected (read-only)",
    create.isError === true && /read[\s-]?only/i.test(resultText(create)),
    resultText(create)
  );
} catch (err) {
  console.error(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
  console.error(stderr);
  failures++;
} finally {
  // Best-effort: a close failure must not mask the real test outcome
  await client.close().catch(() => {});
}

// The server logs "Skipping <name> connector: ..." when a driver package is
// missing from the bundle's node_modules — that means the packaging is broken.
check(
  "all connectors loaded (no drivers skipped)",
  !stderr.includes("Skipping"),
  stderr.split("\n").filter((line) => line.includes("Skipping")).join("; ")
);

if (failures > 0) {
  console.error(`\n${failures} smoke test check(s) failed`);
  process.exit(1);
}
console.log("\nMCP Bundle smoke test passed");
