# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# DBHub Development Guidelines

DBHub is a zero-dependency, token efficient database MCP server implementing the Model Context Protocol (MCP) server interface. This lightweight server bridges MCP-compatible clients (Claude Desktop, Claude Code, Cursor) with various database systems.

## Commands

- Build: `pnpm run build` - Compiles TypeScript to JavaScript using tsup
- Start: `pnpm run start` - Runs the compiled server
- Dev: `pnpm run dev` - Runs the backend (tsx, HTTP transport, no compilation) and the workbench frontend together; `pnpm run dev:backend` runs the server alone and accepts flags (`pnpm run dev:backend --config=./dbhub.toml`)
- Typecheck: `pnpm run typecheck` - `tsc --noEmit` over `src/`, tests included (CI runs it; Vitest and tsx do not check types)
- Test: `pnpm test` - Run all tests
- Test Watch: `pnpm test:watch` - Run tests in watch mode
- Integration Tests: `pnpm test:integration` - Run database integration tests (requires Docker)
- Build Smoke Test: `pnpm test:build` - After `pnpm run build`, imports each connector chunk in `dist/` to catch CJS drivers bundled into ESM (`scripts/smoke-test-build.mjs`; add new connectors to its file pattern)
- Claude Code Plugin: `plugin/` packages DBHub as a Claude Code plugin — `.mcp.json` launches `npx @bytebase/dbhub` (pinned to the plugin version) against the bundled read-only `plugin/dbhub.toml` (DSN prompted via `userConfig` in `plugin/.claude-plugin/plugin.json`, passed as `DBHUB_DSN`), plus `/dbhub:setup` and `/dbhub:explore` skills. Validate with `claude plugin validate ./plugin`; test with `claude --plugin-dir ./plugin`.
- Codex Plugin: the same `plugin/` directory also serves Codex — `plugin/.codex-plugin/plugin.json` is the manifest and points at `plugin/mcp.codex.json` (not `.mcp.json`, whose `${CLAUDE_PLUGIN_ROOT}`/`${user_config.*}` placeholders Codex doesn't expand). Codex has no install-time prompt, so the server forwards `DBHUB_DSN` from Codex's environment (`env_vars`) and finds `./dbhub.toml` via `cwd = "."` (resolved against the installed plugin root). Skills are shared, so keep them host-neutral. The Codex marketplace is `.agents/plugins/marketplace.json` (Codex prefers it over `.claude-plugin/marketplace.json`). Test with a throwaway home: `CODEX_HOME=/tmp/codex-home codex plugin marketplace add . && CODEX_HOME=/tmp/codex-home codex plugin add dbhub@dbhub`, then `codex mcp list`.
- Versioning: `package.json` is the single source of truth. `pnpm version <bump>` bumps it and auto-runs `scripts/sync-version.mjs`, which propagates the version into `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.mcp.json`, `plugin/mcp.codex.json`, and `server.json` (files that can't be stamped at build time — the plugin is read straight from git with no build step, and `server.json`'s own version is what the npm publish workflow (`.github/workflows/npm-publish.yml`) checks against the MCP Registry before republishing — the registry publish runs as a post-step of that same workflow, after the npm publish succeeds). `mcpb/manifest.json` needs no sync — `scripts/build-mcpb.mjs` stamps it from `package.json` at build time. `src/__tests__/plugin-consistency.test.ts` fails CI if any of these drift from `package.json`, or if `plugin/dbhub.toml` diverges from `mcpb/dbhub.toml`.
- MCP Bundle: `pnpm run build:mcpb` - Package DBHub as an `.mcpb` bundle for MCPB-compatible clients (Claude Desktop, Claude Code, MCP for Windows; see `mcpb/` and `scripts/build-mcpb.mjs`); `pnpm run test:mcpb` smoke-tests the packed bundle over stdio. Published to GitHub releases by `.github/workflows/mcpb-release.yml`. The bundle is read-only by design (`mcpb/dbhub.toml`), with the DSN supplied via the `DBHUB_DSN` env var declared in `mcpb/manifest.json` (TOML `${ENV_VAR}` interpolation).

## Architecture Overview

The codebase follows a modular architecture centered around the MCP protocol:

```
src/
├── connectors/          # Database-specific implementations
│   ├── postgres/        # PostgreSQL connector
│   ├── mysql/           # MySQL connector
│   ├── mariadb/         # MariaDB connector
│   ├── sqlserver/       # SQL Server connector
│   ├── oracle/          # Oracle connector (node-oracledb Thin mode, no Instant Client)
│   ├── clickhouse/      # ClickHouse connector (@clickhouse/client over the HTTP interface)
│   └── sqlite/          # SQLite connector
├── tools/               # MCP tool handlers
│   ├── execute-sql.ts   # SQL execution handler
│   ├── search-objects.ts  # Unified search/list with progressive disclosure
│   ├── explain-sql.ts   # Opt-in EXPLAIN plan tool (never executes the target statement)
│   └── health-check.ts  # Opt-in connection pool + buffer cache metrics tool (Postgres/MySQL/MariaDB/SQL Server/Oracle)
├── utils/               # Shared utilities
│   ├── dsn-obfuscate.ts # DSN security
│   ├── response-formatter.ts # Output formatting
│   ├── allowed-keywords.ts  # Read-only SQL classification primitives
│   ├── result-columns.ts    # Unique column names for result rows (repeats → `_1`, `_2`; connectors fetch rows positionally)
│   └── sql-access-policy.ts # Statement class → verdict pipeline (single source of readonly semantics)
└── index.ts             # Entry point with transport handling
```

Key architectural patterns:
- **Connector Registry**: Dynamic registration system for database connectors
- **Connector Manager**: Manages database connections (single or multiple)
  - Supports multi-database configuration via TOML
  - Maintains `Map<id, Connector>` for named connections
  - `getConnector(sourceId?)` returns connector by ID or default (first)
  - `getCurrentConnector(sourceId?)` static method for tool handlers
  - Backward compatible with single-connection mode
  - Location: `src/connectors/manager.ts`
- **Transport Abstraction**: Support for both stdio (desktop tools) and HTTP (network clients)
  - HTTP transport endpoint: `/mcp` (aligns with official MCP SDK standard)
  - Implemented in `src/server.ts` using `createMcpHandler` (MCP SDK v2), which serves both protocol eras from one factory: the stateless 2026-07-28 revision natively, and 2025-era clients via the default `legacy: 'stateless'` fallback (fresh server per request, spec-standard SSE-framed responses; GET/DELETE on the legacy path return 405)
  - stdio uses `serveStdio` from `@modelcontextprotocol/server/stdio` (era pinned per connection)
  - 2026-07-28 clients get cache hints on `tools/list` (`cacheHints` in `ServerOptions`: 5-minute TTL, `private` scope) and send `Mcp-Method`/`Mcp-Name` headers usable for gateway routing/rate-limiting
  - Tests in `src/__tests__/json-rpc-integration.test.ts`
- **Tool Handlers**: Clean separation of MCP protocol concerns
  - Every handler (built-in and custom) runs inside `runToolRequest` (`src/utils/tool-handler-helpers.ts`): it connects lazily, shapes the success/error envelope, classifies connection failures and records the request trace. A handler body returns its data and throws `ToolError(message, code)` for failures it diagnoses itself.
  - A built-in tool is described in two tables keyed by tool name — metadata in `BUILTIN_TOOL_METADATA` (`src/utils/tool-metadata.ts`, shared by registration and the API tool list) and schema + handler in `BUILTIN_TOOL_HANDLERS` (`src/tools/index.ts`). Adding one means an entry in each plus the name in `src/tools/builtin-tools.ts`; `builtin-tool-table.integration.test.ts` checks they agree.
  - Multi-database routing is by tool name, not by parameter: one tool instance is registered per source, named `execute_sql_{source_id}` / `search_objects_{source_id}` (single-source configs keep the bare `execute_sql` / `search_objects` names). See `src/tools/index.ts` and `src/utils/tool-metadata.ts`. `source_id` appears in tool *output* metadata only.
- **Token-Efficient Schema Exploration**: Unified search/list tool with progressive disclosure
  - `search_objects`: Single tool for both pattern-based search and listing all objects
  - Pattern parameter defaults to `%` (match all) - optional for listing use cases
  - Detail levels: `names` (minimal), `summary` (with metadata), `full` (complete structure)
  - Supports: schemas, tables, views, columns, procedures, functions, indexes
  - Inspired by Anthropic's MCP code execution patterns for reducing token usage
- **Integration Test Base**: Shared test utilities for consistent connector testing

## Configuration

DBHub supports three configuration methods:

### 1. TOML Configuration File (Multi-Database)
**Recommended for projects requiring multiple database connections**

- Load with `--config=path/to/config.toml` (see `resolveTomlConfigPath` in `src/config/toml-loader.ts`)
- Configuration structure:
  - `[[sources]]` - Database connection definitions with unique `id` fields
  - `[[tools]]` - Tool configuration (execution settings, custom tools)
- Example:
  ```toml
  [[sources]]
  id = "prod_pg"
  dsn = "postgres://user:pass@localhost:5432/production"
  connection_timeout = 60
  query_timeout = 30

  [[sources]]
  id = "staging_mysql"
  type = "mysql"
  host = "localhost"
  database = "staging"
  user = "root"
  password = "secret"

  # Tool configuration (readonly, max_rows are tool-level settings)
  [[tools]]
  name = "execute_sql"
  source = "prod_pg"
  readonly = true
  max_rows = 1000

  [[tools]]
  name = "search_objects"
  source = "prod_pg"
  ```
- Key files:
  - `src/types/config.ts`: TypeScript interfaces for TOML structure
  - `src/config/toml-loader.ts`: TOML parsing and validation
  - `src/config/__tests__/toml-loader.test.ts`: Comprehensive test suite
- Features:
  - Per-source settings: SSH tunnels, timeouts, SSL configuration
  - Per-tool settings: `readonly`, `max_rows` (configured in `[[tools]]` section, not `[[sources]]`)
  - Custom tools: Define reusable, parameterized SQL operations
  - Path expansion for `~/` in file paths
  - Automatic password redaction in logs
  - First source is the default database
- Usage in MCP tools: each source gets its own tool, suffixed with the normalized source id (e.g. `execute_sql_prod_pg(sql)`, `search_objects_staging_mysql(...)`)
- See `dbhub.toml.example` for complete configuration reference
- Documentation: https://dbhub.ai/config/toml

### 2. Environment Variables (Single Database)
- Copy `.env.example` to `.env` and configure for your database connection
- Two ways to configure:
  - Set `DSN` to a full connection string (recommended)
  - Set individual parameters: `DB_TYPE`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- SSH tunnel via environment: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`, `SSH_KEY`, `SSH_PASSPHRASE`

### 3. Command-Line Arguments
- `--dsn`: Database connection string (single database; cannot be combined with TOML config)
- `--transport`: `stdio` (default) or `http` for streamable HTTP transport (endpoint: `/mcp`)
- `--port`: HTTP server port (default: 8080)
- `--host`: HTTP bind host (default: `0.0.0.0`; env `DBHUB_HOST`)
- `--allowed-hosts`: Comma-separated extra hostnames accepted in the HTTP `Host`/`Origin` headers, for DNS-rebinding protection (env `DBHUB_ALLOWED_HOSTS`). Loopback is always allowed; on a wildcard bind (`0.0.0.0`/`::`) this machine's hostname and IPs are auto-allowed so local/by-IP access needs no config. Set the flag for other names (e.g. a reverse-proxy/public DNS name); use `*` to disable the check when fronted by your own auth/proxy. See `buildAllowedHosts`/`getSelfHosts` in `src/utils/cross-origin.ts`.
- `--auth-token`: Comma-separated bearer token(s) required on every HTTP request via `Authorization: Bearer <token>` (env `DBHUB_AUTH_TOKEN`). Unset by default (no auth); configuring a token is itself the opt-in — there is no separate enforcement flag. A comma-separated list supports zero-downtime rotation (add the new token, redeploy, drop the old one) and per-client tokens. `/healthz` is exempt. Not OAuth — a flat shared-secret allow-list, not full identity-based authorization; see `validateAuthToken` in `src/utils/auth-token.ts`.
- `--config`: Path to TOML configuration file
- `--demo`: Use bundled SQLite employee database
- `--readonly` / `--max-rows` (and the `READONLY` / `MAX_ROWS` environment variables): removed. Using one exits at startup with a pointer to the TOML `[[tools]]` `readonly` / `max_rows` settings — see `rejectRemovedEnvVars` / `failRemovedSetting` in `src/config/env.ts`
- SSH tunnel options: `--ssh-host`, `--ssh-port`, `--ssh-user`, `--ssh-password`, `--ssh-key`, `--ssh-passphrase`, `--ssh-agent`
- Documentation: https://dbhub.ai/config/command-line

### Configuration Priority Order

**Database sources** come from either a TOML file (`--config`) or a DSN. TOML defines
sources for one or more databases; a DSN configures exactly one, so `--config` and
`--dsn` together throw — see `resolveSourceConfigs` in `src/config/env.ts`.

The guard is deliberately limited to the `--dsn` flag. `DSN` and `DB_*` environment
variables (exported or from `.env`) are left alone because TOML `${VAR}` interpolation
reads them: `dsn = "${DSN}"` is a supported way to keep credentials out of the file.

Without `--config`, the DSN is resolved in this order:
1. `--dsn` command-line argument
2. `DSN` environment variable
3. Individual `DB_*` environment variables
4. `.env` files (`.env.local` in development, `.env` in production)

**All other settings** (`--transport`, `--port`, `--host`, `--allowed-hosts`, …) live
outside TOML and follow the same order:
1. Command-line arguments
2. Environment variables
3. `.env` files
4. Built-in defaults

## Database Connectors

- Add new connectors in `src/connectors/{db-type}/index.ts`
- Implement the `Connector` and `DSNParser` interfaces from `src/connectors/interface.ts`
- Register connector with `ConnectorRegistry.register(connector)`
- Shared connector code — reuse it rather than re-implementing per connector:
  - `src/connectors/mysql-family-connector.ts`: base class for MySQL and MariaDB (introspection, health check, and `executeStatements`, the split → row-cap → run → per-statement result-set flow). Only what differs by driver stays in the subclasses: pool setup, how a query is issued and timed out, and how a timed-out connection is discarded. The sibling `mysql-family-*.ts` files hold the shared catalog queries, health check and `sslmode` handling.
  - `src/connectors/sqlserver/request-helpers.ts`: parameter binding, read-only escape checks, `collectInfoMessages`, and `runRolledBack` — the always-rolled-back transaction every SQL Server read-only path (execute and `EXPLAIN ANALYZE`) goes through.
  - `src/connectors/introspection-utils.ts`: `groupIndexColumns`, for catalogs that list an index one column per row.
  - `src/utils/home-dir.ts`: `expandHomeDir`, the one `~/` expansion for every path option (SQLite database paths have their own rules in `sqlite-dsn.ts`).
  - `src/utils/safe-url.ts`: `SafeURL`, plus `rawQueryParamValues` for a parameter (like `sslmode`) whose empty value must be rejected rather than treated as absent.
- ClickHouse (`src/connectors/clickhouse/index.ts`) differs from the pooled connectors in ways worth knowing before changing it:
  - It is stateless: one HTTP request per statement, no session, so `SET`/`USE`/temporary tables do not carry between statements. `[sources.session]` settings and `query_timeout` (`max_execution_time`) are sent as settings with every request.
  - Read-only is the `readonly = 1` setting on the request, enforced by the server. A user whose own profile is `readonly = 1` may not change any setting (nothing is sent; `[sources.session]` fails the connect) and one at `readonly = 2` may not change `readonly` (it is left off); the level is probed at connect time.
  - `max_rows` is applied by reading rows off the streamed response and closing it, never by rewriting SQL; `sql-row-limiter.ts` is not used.
  - Rows are read as `JSONCompactEachRowWithNamesAndTypes` (positional, so repeated column names survive). Numbers a double cannot hold exactly (64-bit integers, wide decimals) stay strings (`keepExactNumbers`), and `Decimal` columns are always strings.
  - An error raised after rows were sent must never come back as data. `http_write_exception_in_output_format = 0` is sent so it arrives as text; for a `readonly = 1` user whose profile has it on, a final one-string row that reads as an error is judged by column type and response size (`runStatement`).
  - `query_timeout` is bounded on the client by elapsed time (`Deadline`), covering the request and the reading of its response; the HTTP client's own inactivity timeout is switched off.
  - For a `readonly = 2` user, a read-only statement with a `SETTINGS` clause is refused in the connector (`hasSettingsClause`), since the server would let it lift `[sources.session]` limits.
  - `SQLResult.messages` carries rows/bytes read per statement from the `X-ClickHouse-Summary` header, only when the response fit the server-side `buffer_size` and was read to the end (otherwise the header is not final).
  - Custom-tool placeholders are `{p1:Type}`, `{p2:Type}` (`braced` style in `parameter-mapper.ts`). `getTableIndexes` reports `PRIMARY KEY`, `ORDER BY` and skipping indexes, never as unique. No `getHealthCheck`.
- DSN Examples:
  - PostgreSQL: `postgres://user:password@localhost:5432/dbname?sslmode=disable`
  - MySQL: `mysql://user:password@localhost:3306/dbname?sslmode=disable`
  - MariaDB: `mariadb://user:password@localhost:3306/dbname?sslmode=disable`
  - SQL Server: `sqlserver://user:password@localhost:1433/dbname?sslmode=disable`
  - SQL Server (named instance): `sqlserver://user:password@localhost:1433/dbname?instanceName=ENV1`
  - SQL Server (NTLM): `sqlserver://user:password@localhost:1433/dbname?authentication=ntlm&domain=MYDOMAIN`
  - Oracle: `oracle://user:password@localhost:1521/FREEPDB1` (path is the service name; `?sid=ORCL` for a SID; `sslmode=require`/`verify-full` switch to TCPS)
  - ClickHouse: `clickhouse://user:password@localhost:8123/dbname` (the HTTP interface; `sslmode=require`/`verify-full` switch to HTTPS and default the port to 8443, as on ClickHouse Cloud)
  - SQLite: `sqlite:///path/to/database.db` (absolute), `sqlite:///./database.db` (relative: to the working directory, or to the config file when set in TOML) or `sqlite:///:memory:` — all forms and their resolution live in `src/utils/sqlite-dsn.ts`
- SSL modes: `sslmode=disable` (no SSL), `sslmode=require` (SSL without cert verification), `sslmode=verify-ca` (PostgreSQL, MySQL and MariaDB, CA verification), `sslmode=verify-full` (every network database, CA + hostname verification). MySQL/MariaDB validation and the per-driver mapping live in `src/connectors/mysql-family-ssl.ts` and each connector's `*SslOptions`; unknown values are rejected. On PostgreSQL, use `sslrootcert` to specify CA certificate path for verify modes. PostgreSQL client certificate auth: `sslcert` + `sslkey` (PEM, unencrypted, both required; `sslmode` must be `require`, `verify-ca` or `verify-full` — `disable` or unset is rejected) in the DSN or TOML source.

## Testing Approach

For detailed guidance on running and troubleshooting tests, refer to the [testing skill](.claude/skills/testing/SKILL.md). This skill is automatically activated when working with tests, test failures, or Docker/database container issues.

Key points:
- Unit tests for individual components and utilities
- Integration tests using Testcontainers for real database testing
- All connectors have comprehensive integration test coverage
- Test specific databases: `pnpm test src/connectors/__tests__/{db-type}.integration.test.ts`
- SSH tunnel tests: `pnpm test postgres-ssh.integration.test.ts`

## SSH Tunnel Support

DBHub supports SSH tunnels for secure database connections through bastion hosts:

- Configuration via command-line options: `--ssh-host`, `--ssh-port`, `--ssh-user`, `--ssh-password`, `--ssh-key`, `--ssh-passphrase`, `--ssh-agent`
- Configuration via environment variables: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`, `SSH_KEY`, `SSH_PASSPHRASE`, `SSH_AUTH_SOCK`
- SSH config file support: Automatically reads from `~/.ssh/config` when using host aliases
- Implementation in `src/utils/ssh-tunnel.ts` using the `ssh2` library
- SSH config parsing in `src/utils/ssh-config-parser.ts` using the `ssh-config` library
- Automatic tunnel establishment when SSH config is detected
- Support for password, key-based, and SSH agent authentication (agent via `--ssh-agent`, TOML `ssh_agent`, or `SSH_AUTH_SOCK`, offered to every hop after any explicit password/key; makes `ssh_password`/`ssh_key` optional)
- A key picked up from `~/.ssh/config` that ssh2 cannot parse (e.g. encrypted, no passphrase) is skipped when a password or agent is available (`privateKeyDiscovered` in `SSHTunnelConfig`); an explicitly configured key never is
- Default SSH key detection (tries `~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, etc.)
- Tunnel lifecycle managed by `ConnectorManager`

## Code Style

- TypeScript with strict mode enabled
- ES modules with `.js` extension in imports
- Group imports: Node.js core modules → third-party → local modules
- Use camelCase for variables/functions, PascalCase for classes/types
- Include explicit type annotations for function parameters/returns
- Use try/finally blocks with DB connections (always release clients)
- Prefer async/await over callbacks and Promise chains
- Format error messages consistently
- Use parameterized queries for DB operations
- Validate inputs with zod schemas
- Include fallbacks for environment variables
- Use descriptive variable/function names
- Keep functions focused and single-purpose
