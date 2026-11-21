# Database MCP tool-definition benchmark

Captured November 21, 2026 on macOS arm64, Node.js 24.1.0. Published npm versions were checked that day: DBHub 2.0.1, MCP Toolbox 1.18.0, Supabase MCP 0.19.0.

## Recount the saved schemas

```bash
cd benchmarks/token-definitions
npm ci
node count.mjs
```

Expected totals: DBHub **261**, Toolbox **3,901**, Supabase **6,982**.

`count.mjs` selects only `name`, `description`, and `inputSchema` from each tool, sorts tools by name and object keys recursively, then counts the compact JSON array using `cl100k_base` from `js-tiktoken@1.0.21`. Array order inside schemas is preserved. No whitespace or trailing newline is added to the counted payload. Each result contains its payload's SHA-256 and standalone per-tool counts. The array total is counted directly, not summed from per-tool counts.

These are exact counts for this representation and encoding, not Claude token counts, API billing counts, or total session overhead. Annotations, output schemas, instructions, client wrappers, and tool results are excluded. Raw snapshots retain the server's returned fields so readers can inspect the exclusions.

## Capture again

The capture script only initializes servers and calls `tools/list`; it never calls a tool. It follows pagination and fails on an empty tool list. It replaces the three snapshots, so inspect the diff before accepting a new run.

Start an isolated PostgreSQL instance for Toolbox:

```bash
docker run -d --rm --name dbhub-token-benchmark-postgres \
  -e POSTGRES_PASSWORD=benchmark \
  -p 127.0.0.1:55439:5432 postgres:17-alpine
npm run capture -- mcp.example.json
node count.mjs > results.json
docker stop dbhub-token-benchmark-postgres
```

`mcp.example.json` pins each npm server version. DBHub uses `--demo`; Toolbox uses `--prebuilt postgres`. Supabase uses its local stdio server with no project restriction, read-only flag, or feature filter. Version 0.19.0 accepts a placeholder access token for discovery, so no real credential is needed. No Supabase tool was executed. The hosted Supabase endpoint was not measured.

The original capture used locally installed copies of those exact npm versions rather than npx. The PostgreSQL image digest was `sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32`. PostgreSQL was empty; its data is not part of the measured definitions.

## Why not sum Claude Code's report?

`claude-context.txt` preserves the diagnostic report from Claude Code 2.1.330, with `ENABLE_TOOL_SEARCH=false`, the three servers loaded via `--mcp-config`, and `--strict-mcp-config --setting-sources '' --no-session-persistence -p /context`. It is supporting evidence, not the source of the published totals. It labels usage as estimated and rounds `create_notebook` to `1.5k`, so the displayed rows cannot yield an exact Supabase total. No model prompt or database query was needed.

The old article used Claude Code estimates. Its numbers and the current tokenizer counts should not be compared as a historical reduction.
