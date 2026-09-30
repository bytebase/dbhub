# DBHub + DuckDB + Bifrost + Ollama — Handoff Document

**Date:** 2026-09-30
**Owner:** DigiBull / solutionsDigibull
**Status:** Working end-to-end, ready for team handoff
**Repos:** https://github.com/solutionsDigibull/dbhub (branch `duckdb-connector`, commit `8db1386`)

---

## 1. What Was Built

A fully local, no-API MCP pipeline that lets a local LLM query **PostgreSQL** and **DuckDB** simultaneously through a single MCP endpoint.

```
┌─────────────────┐     ┌──────────────┐     ┌─────────────────────┐
│  MCP Client /   │────▶│   Bifrost    │────▶│      DBHub          │
│  Chat UI        │     │  (Docker)    │     │  (Windows host)     │
│                 │◀────│  :8010       │◀────│  :8020              │
└─────────────────┘     └──────┬───────┘     └──────────┬──────────┘
                               │                        │
                               ▼                        ├──▶ PostgreSQL
                        ┌──────────────┐                │    192.168.1.18:5432
                        │   Ollama     │                │    logic_db_2
                        │  (Windows)   │                │
                        │   :11434     │                └──▶ DuckDB
                        │  qwen2.5-    │                     C:/SRIM-DB-SETUP/
                        │  coder:7b    │                     Databases/
                        └──────────────┘                     Bom_storage.duckdb
```

**Why this design:**
- DBHub has no native DuckDB connector — we built one and patched it into a private fork.
- Bifrost is the MCP gateway + LLM router. Docker-hosted, so it needs `host.docker.internal` to reach Windows host services.
- Ollama runs on Windows host, bound to `0.0.0.0:11434` so the Docker container can reach it.

---

## 2. Deliverables

| Artifact | Location | Purpose |
|---|---|---|
| DBHub fork | `github.com/solutionsDigibull/dbhub` branch `duckdb-connector` | Custom DuckDB connector |
| `duckdb/index.ts` | `src/connectors/duckdb/index.ts` | The connector implementation |
| `dbhub.toml` | repo root | Multi-source configuration |
| Bifrost provider config | Bifrost API / UI | Ollama provider |
| Bifrost MCP client config | Bifrost API / UI | `DBHub_MCP` client |
| This document | repo / wiki | Handoff + reproduction |

---

## 3. DBHub Fork — Files Changed (14 total)

### 3.1 New File: `src/connectors/duckdb/index.ts`

The complete connector. Key features:

- **DSN parser** accepts `duckdb:///C:/path/file.duckdb` and strips the leading `/` on Windows drive letters (DuckDB otherwise treats `/C:/...` as a UNC path).
- **`connect`** uses `DuckDBInstance.fromCache()` to avoid attaching the same file twice in one process.
- **`executeSQL`** returns `{ resultSets: [{ rows, rowCount }] }` — matches `SQLResultSet` in `interface.ts`.
- Uses `result.getRowObjectsJS()` to convert DuckDB types (BIGINT, DECIMAL, DATE, TIMESTAMP, LIST, STRUCT) to native JS values.
- Implements all required interface methods: `getSchemas`, `getTables`, `getViews`, `getTableSchema`, `tableExists`, `getTableIndexes`, `getStoredProcedures`, `getStoredProcedureDetail`, `executeSQL`, plus optional `getTableRowCount`, `getTableComment`.

### 3.2 Modified Files — Add `"duckdb"` to Every Type Union

| File | Change |
|---|---|
| `src/connectors/interface.ts` | `ConnectorType` union += `"duckdb"` |
| `src/types/config.ts` | `SourceConfig.type` union += `"duckdb"` |
| `src/utils/dsn-obfuscate.ts` | `protocolToConnectorType` map += `duckdb: "duckdb"`; `ports` map += `duckdb: undefined`; `parseConnectionInfoFromDSN` short-circuits DuckDB like SQLite |
| `src/config/toml-loader.ts` | `validTypes` array += `"duckdb"` |
| `src/utils/allowed-keywords.ts` | `allowedKeywords` and `mutatingPatterns` records += DuckDB entries (copy from SQLite) |
| `src/utils/sql-parser.ts` | `dialectScanners` record += `duckdb: sqliteScanner` |
| `src/utils/error-classifier.ts` | `AUTH_CODES` record += `duckdb: []` |
| `src/utils/parameter-mapper.ts` | `PARAMETER_STYLES` += `duckdb: "?"` |
| `src/api/openapi.yaml` | `DataSource.type` enum += `duckdb`; regenerate with `pnpm run generate:api-types` |

### 3.3 Modified File — `src/index.ts`

Add DuckDB to the connector loader array:

```typescript
{ load: () => import("./connectors/duckdb/index.js"),
  name: "DuckDB",
  driver: "@duckdb/node-api" },
```

### 3.4 Build Changes

- `package.json` → add dependency `@duckdb/node-api` (installed with `pnpm add @duckdb/node-api -w`)
- `pnpm-lock.yaml` — updated automatically

---

## 4. Runtime Configuration

### 4.1 `dbhub.toml`

```toml
[[sources]]
id = "postgres_logic"
description = "Production PostgreSQL database"
dsn = "postgresql://postgres:DigiBull@192.168.1.18:5432/logic_db_2?sslmode=disable"

[[sources]]
id = "duckdb_local"
description = "Local DuckDB analytical database"
dsn = "duckdb:///C:/SRIM-DB-SETUP/Databases/Bom_storage.duckdb"
```

### 4.2 DBHub Start Command

**Critical:** `--allowed-hosts` must include `host.docker.internal` — DBHub rejects any request whose `Host` header is not on its allow-list with HTTP 403.

```powershell
node dist/index.js `
  --transport http `
  --port 8020 `
  --config ./dbhub.toml `
  --allowed-hosts "host.docker.internal"
```

To make this permanent, set the env var before starting:

```powershell
$env:DBHUB_ALLOWED_HOSTS = "host.docker.internal"
```

### 4.3 Ollama on Windows

Bind to all interfaces so Docker can reach it:

```powershell
[System.Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "User")
```

Restart Ollama. Verify from Docker:

```powershell
docker exec -it bifrost wget -qO- http://host.docker.internal:11434/api/tags
```

### 4.4 Bifrost — Ollama Provider (Two-Step Since v1.5.0)

**Step 1 — Create provider without keys:**

```json
POST /api/providers
{
  "provider": "ollama",
  "network_config": {
    "base_url": "http://host.docker.internal:11434",
    "default_request_timeout_in_seconds": 300,
    "allow_private_network": true
  }
}
```

`allow_private_network: true` is required — Bifrost blocks private IPs by default.

**Step 2 — Add the key separately:**

```json
POST /api/providers/ollama/keys
{
  "name": "ollama-local",
  "value": "ollama",
  "models": ["*"],
  "weight": 1.0,
  "ollama_key_config": {
    "url": "http://host.docker.internal:11434"
  }
}
```

Do **not** embed the `keys` array in the provider creation payload — v1.5.0 ignores it silently.

### 4.5 Bifrost — DBHub MCP Client

```json
POST /api/mcp/client
{
  "name": "DBHub_MCP",
  "connection_type": "http",
  "connection_string": "http://host.docker.internal:8020/mcp",
  "auth_type": "none",
  "tools_to_execute": ["*"]
}
```

Then set `allow_on_all_virtual_keys: true` and `allow_by_default: true` via `PUT /api/mcp/client/{id}` so the tools are visible without a Virtual Key.

### 4.6 Bifrost — Access Control

| Setting | Where | Value |
|---|---|---|
| `tools_to_execute` | MCP client | `["*"]` |
| `allow_by_default` | MCP client | `true` |
| `allow_on_all_virtual_keys` | MCP client | `true` |
| Virtual Key MCP configs | If used | Add `DBHub_MCP` with `["*"]` |

Since Bifrost v1.5.0, an empty Virtual Key `mcp_configs` array means **deny all** (previously "allow all"). This caught us during setup.

---

## 5. Verification Commands

Run these in order to confirm each layer is working.

### 5.1 DBHub Serving Tools Directly

```powershell
curl.exe -X POST http://localhost:8020/mcp `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1}'
```

Expected: SSE response with 4 tools.

### 5.2 Bifrost Reaches DBHub

```powershell
docker exec -it bifrost wget -qO- \
  --header='Accept: application/json, text/event-stream' \
  --header='Content-Type: application/json' \
  http://host.docker.internal:8020/mcp
```

Expected: no 403.

### 5.3 Bifrost Discovers 4 Tools

```powershell
$headers = @{
  "Authorization" = "Bearer <base64(DigiBull:DigiBull@2026)>"
  "Content-Type"  = "application/json"
}
$clients = Invoke-RestMethod -Uri "http://localhost:8010/api/mcp/clients" -Headers $headers
$clients.clients | Where-Object { $_.config.name -eq "DBHub_MCP" } |
  Select-Object name, state, @{N='Tools';E={$_.tools.Count}}
```

Expected: `Tools: 4`.

### 5.4 Ollama Reachable from Bifrost

```powershell
Invoke-RestMethod -Uri "http://localhost:8010/v1/models" -Headers $headers |
  Select-Object -ExpandProperty data | Select-Object id
```

Expected: `ollama/qwen2.5-coder:7b`, `ollama/qwen3:8b`, etc.

---

## 6. End-to-End Query Flow (The Pattern to Reuse)

Due to `qwen2.5-coder:7b` not emitting native `tool_calls`, use this **4-step manual pattern**:

```powershell
# ============================================================
# Bifrost + Ollama + DBHub MCP — end-to-end tool-call pipeline
# ============================================================

$headers = @{
  "Authorization"            = "Bearer RGlnaUJ1bGw6RGlnaUJ1bGxAMjAyNg=="
  "Content-Type"             = "application/json"
  "x-bf-mcp-include-clients" = "DBHub_MCP"
}

$BaseUrl = "http://192.168.1.18:8010"
$Model   = "ollama/qwen2.5-coder:7b"
$CallId  = "call_auto_1"
$UserMsg = "Show me 10 rows from gerber_checklist"

# ------------------------------------------------------------
# 1. Ask the model
# ------------------------------------------------------------
Write-Host "`n=== [1] Asking the model ===" -ForegroundColor Cyan

$chat = Invoke-RestMethod -Uri "$BaseUrl/v1/chat/completions" `
  -Method Post -Headers $headers -Body (@{
    model    = $Model
    messages = @( @{ role = "user"; content = $UserMsg } )
  } | ConvertTo-Json -Depth 5)

$raw = [string]$chat.choices[0].message.content

# ------------------------------------------------------------
# 2. Parse the tool call (defensive)
# ------------------------------------------------------------
Write-Host "`n=== [2] Parsing tool call ===" -ForegroundColor Cyan

$raw = $raw.Trim()
$raw = $raw -replace '^\s*```(?:json)?\s*', '' -replace '\s*```\s*$', ''
if ($raw.StartsWith('{') -and -not $raw.EndsWith('}')) { $raw += '}' }

try { $call = $raw | ConvertFrom-Json } catch { throw "Bad JSON:`n$raw" }
if (-not $call.name) { throw "No 'name' field:`n$raw" }

$toolName = $call.name
$toolArgs = $call.arguments
Write-Host "Tool name : $toolName"
Write-Host "Tool args : $($toolArgs | ConvertTo-Json -Compress)"

# ------------------------------------------------------------
# 3. Execute through Bifrost (OpenAI function-call envelope)
# ------------------------------------------------------------
Write-Host "`n=== [3] Executing tool via Bifrost ===" -ForegroundColor Cyan

$execBody = @{
    id       = $CallId
    type     = "function"
    function = @{
        name      = $toolName
        arguments = ($toolArgs | ConvertTo-Json -Compress)
    }
} | ConvertTo-Json -Depth 10 -Compress

$result = Invoke-RestMethod -Uri "$BaseUrl/v1/mcp/tool/execute" `
  -Method Post -Headers $headers -Body $execBody

# ------------------------------------------------------------
# 3b. Extract the tool payload — FIXED (block form, not if/elseif expr)
#     Bifrost returns: { role, content: "<json string>", tool_call_id }
#     We parse the inner JSON and pull just the rows for a cleaner prompt.
# ------------------------------------------------------------
if ($result -is [string]) {
    $toolJsonStr = $result
} elseif ($null -ne $result.content) {
    $toolJsonStr = if ($result.content -is [string]) { $result.content } else { $result.content | ConvertTo-Json -Depth 10 -Compress }
} else {
    $toolJsonStr = $result | ConvertTo-Json -Depth 10 -Compress
}

# Try to unwrap the DBHub envelope: { success, data: { statements: [ { rows: [...] } ] } }
$rowsPayload = $null
try {
    $inner = $toolJsonStr | ConvertFrom-Json
    if ($inner.data.statements[0].rows) {
        $rowsPayload = $inner.data.statements[0].rows
    }
} catch { }

if ($rowsPayload) {
    # Compact rows-only payload for the model
    $toolContent = @{
        rows  = $rowsPayload
        count = $rowsPayload.Count
    } | ConvertTo-Json -Depth 10 -Compress
    Write-Host "Extracted $($rowsPayload.Count) rows for the model." -ForegroundColor Green
} else {
    # Fall back to raw tool string
    $toolContent = $toolJsonStr
    Write-Host "Could not unwrap rows; passing raw tool output." -ForegroundColor Yellow
}

# ------------------------------------------------------------
# 4. Feed result back — with a system prompt so it summarizes
#    instead of echoing raw JSON.
# ------------------------------------------------------------
Write-Host "`n=== [4] Asking model to summarize tool result ===" -ForegroundColor Cyan

$systemPrompt = @"
You are a helpful assistant. You will be given tool results as JSON.
Answer the user's question in plain, natural English.
Do NOT output raw JSON. Do NOT repeat the tool result verbatim.
Summarize the key fields and values.
"@

$answer = Invoke-RestMethod -Uri "$BaseUrl/v1/chat/completions" `
  -Method Post -Headers $headers -Body (@{
    model = $Model
    messages = @(
      @{ role = "system"; content = $systemPrompt }
      @{ role = "user"; content = $UserMsg }
      @{ role = "assistant"; content = ""; tool_calls = @(@{
          id       = $CallId
          type     = "function"
          function = @{
            name      = $toolName
            arguments = ($toolArgs | ConvertTo-Json -Compress)
          }
        })}
      @{ role = "tool"; tool_call_id = $CallId; content = $toolContent }
    )
  } | ConvertTo-Json -Depth 10)

Write-Host "`n=== Final answer ===" -ForegroundColor Yellow
$answer.choices[0].message.content
```

**Why the `x-bf-mcp-include-clients` header matters:** Without it, Bifrost injects tools from all MCP clients (distributor, intake, gerber, etc.), and small models pick the wrong tool. Scoping to `DBHub_MCP` drops the tool count from ~20 to 4 and dramatically improves accuracy.

---

## 7. Known Limitations

| Limitation | Impact | Workaround |
|---|---|---|
| `qwen2.5-coder:7b` emits tool calls as text, not native `tool_calls` | Bifrost cannot auto-execute; manual parsing required | Try `qwen3:8b`; or keep the manual pattern |
| Bifrost in Docker cannot reach Windows `localhost` | All URLs must use `host.docker.internal` | Standard Docker networking |
| DBHub rejects unknown `Host` headers with 403 | Bifrost discovery fails silently (Tools: 0) | `--allowed-hosts host.docker.internal` |
| Fork diverges from upstream DBHub | Future `git pull` on main will conflict on ~10 files | Rebase `duckdb-connector` and re-add `duckdb` to type unions |
| DuckDB `getStoredProcedures` returns `[]` | `search_objects` with `object_type: "procedure"` returns nothing | DuckDB has no stored procedures; use macros |
| `getTableIndexes` returns expressions, not column names | `column_names` field contains the SQL expression | Parse if exact names required |

---

## 8. Dev Team Next Steps

### 8.1 Immediate (Today)

1. `git clone https://github.com/solutionsDigibull/dbhub.git`
2. `git checkout duckdb-connector`
3. `pnpm install && pnpm exec tsup` (skip `pnpm build` — frontend has missing deps)
4. Verify `dist/duckdb-*.js` exists
5. Start DBHub with the `--allowed-hosts` flag
6. Run verification commands in Section 5

### 8.2 Short-Term (This Week)

- Try `qwen3:8b` for native tool_calls — if it works, remove the manual parse step
- Add a system prompt that lists the four DBHub tools to help smaller models
- Write a reusable `Invoke-BifrostTool` PowerShell function for the team
- Add a `Makefile` or `run.ps1` that starts DBHub with the correct flags every time
- Set up an internal npm package `@digibull/dbhub` from the fork's CI

### 8.3 Medium-Term (This Month)

- **Upstream the DuckDB connector** to `bytebase/dbhub` as a Pull Request. The implementation follows their documented `Connector` interface; the change is isolated to ~10 type-union edits + one new file. This would eliminate the maintenance burden.
- Add DuckDB `getTableIndexes` column extraction (parse expressions → names)
- Add DuckDB types tests for BIGINT, DECIMAL, DATE, TIMESTAMP, LIST, STRUCT
- Add a hot-reload test for `dbhub.toml` changes

### 8.4 Long-Term

- Evaluate whether DuckDB's `ATTACH 'postgresql://...'` federation can replace the PostgreSQL source, simplifying to one connection
- Monitor Bifrost v1.6.0 release notes for tool-call handling improvements

---

## 9. Critical Warnings for the Team

1. **Never `git pull origin main` on the `duckdb-connector` branch without rebasing.** The 10+ type-union edits will conflict. Rebase, re-add `"duckdb"`, rebuild.

2. **Never `git checkout main` and `pnpm build`.** The frontend build fails without `cd frontend && pnpm install`. Use `pnpm exec tsup` only.

3. **Never skip `--allowed-hosts host.docker.internal`.** DBHub returns 403 for Docker requests, and the failure is silent on Bifrost's side — you'll see `Tools: 0` with no error.

4. **Never embed `keys` in the Bifrost `/api/providers` payload.** Since v1.5.0, it is ignored silently. Use the separate `/api/providers/{name}/keys` endpoint.

5. **Never use `localhost` in any Docker → Windows host URL.** Always `host.docker.internal`.

---

## 10. Reference — Bifrost Auth Token

The Bifrost admin credentials are:

- Username: `DigiBull`
- Password: `DigiBull@2026`

The Bearer token is `base64("DigiBull:DigiBull@2026")`:

```
RGlnaUJ1bGw6RGlnaUJ1bGxAMjAyNg==
```

Use this in the `Authorization: Bearer <token>` header for all Bifrost API calls. **Do not commit this token to any repo.**

---

## 11. Contact / Ownership

- Fork owner: `solutionsDigibull` (GitHub)
- Bifrost admin: `DigiBull` (local instance)
- Upstream DBHub: `github.com/bytebase/dbhub`
- Bifrost docs: `docs.getbifrost.ai`

---

**Summary:** The pipeline is functional. All four DBHub tools (`execute_sql_postgres_logic`, `search_objects_postgres_logic`, `execute_sql_duckdb_local`, `search_objects_duckdb_local`) are discoverable and callable through Bifrost. Local LLM (`qwen2.5-coder:7b`) can generate correct tool calls. The only remaining ergonomic issue is that the model emits tool calls as text rather than native objects — workable today, improvable with a model swap.
