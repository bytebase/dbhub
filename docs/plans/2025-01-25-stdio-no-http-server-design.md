# Design: Disable HTTP Server for stdio Transport

**Issue:** [#143](https://github.com/bytebase/dbhub/issues/143)
**Date:** 2025-01-25

## Problem

When running DBHub with `--transport stdio`, the application still starts an HTTP server on port 8080. This prevents multiple DBHub instances from running simultaneously, which is a common use case for users running multiple Claude Code or Cursor sessions.

## Solution

Disable the HTTP server entirely when using stdio transport. The HTTP server (admin console, API endpoints, health check) is only needed for HTTP transport mode.

## Design

### Transport Mode Behavior

| Mode | MCP Transport | HTTP Server | Admin Console | API Endpoints |
|------|---------------|-------------|---------------|---------------|
| `--transport stdio` | stdin/stdout | None | No | No |
| `--transport http` | HTTP POST `/mcp` | Port 8080 | Yes | Yes |

### Implementation

Changes are isolated to `src/server.ts`:

**Before:**
```
main()
├── Resolve config, connect to databases
├── Set up Express app (always)
├── Add routes: static files, /healthz, /api/sources, /mcp (if http)
├── Start HTTP server (always)
└── If stdio: also connect StdioServerTransport
```

**After:**
```
main()
├── Resolve config, connect to databases
├── If transport === "http":
│   ├── Set up Express app
│   ├── Add routes: static files, /healthz, /api/sources, /mcp
│   └── Start HTTP server
└── If transport === "stdio":
    ├── Connect StdioServerTransport
    └── (no HTTP server)
```

### Console Output

**stdio mode:**
```
Configuration source: command line
Connecting to 1 database source(s)...
  - demo: sqlite:///:memory:
MCP transport: stdio

 _____  ____  _   _       _
|  __ \|  _ \| | | |     | |
...
v1.x.x [DEMO] - Universal Database MCP Server

MCP server running on stdio - connect via Claude Desktop, Cursor, or Claude Code
```

**http mode:**
```
Configuration source: command line
Connecting to 1 database source(s)...
  - demo: sqlite:///:memory:
MCP transport: http
HTTP server port: 8080 (source: default)

 _____  ____  _   _       _
...
v1.x.x [DEMO] - Universal Database MCP Server

Admin console at http://0.0.0.0:8080/
MCP server endpoint at http://0.0.0.0:8080/mcp
```

## Impact

- Users running multiple stdio instances will no longer encounter port conflicts
- stdio mode has a smaller footprint (no network listeners)
- Users who want the admin console must use `--transport http`
