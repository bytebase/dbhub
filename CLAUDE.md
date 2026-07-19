# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# DBHub Development Guidelines

DBHub is a zero-dependency, token efficient database MCP server implementing the Model Context Protocol (MCP) server interface. This lightweight server bridges MCP-compatible clients (Claude Desktop, Claude Code, Cursor) with various database systems.

## Commands

- Build: `pnpm run build` - Compiles TypeScript to JavaScript using tsup
- Start: `pnpm run start` - Runs the compiled server
- Dev: `pnpm run dev` - Runs server with tsx (no compilation needed)
- Test: `pnpm test` - Run all tests
- Test Watch: `pnpm test:watch` - Run tests in watch mode
- Integration Tests: `pnpm test:integration` - Run database integration tests (requires Docker)
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
│   └── sqlite/          # SQLite connector
├── tools/               # MCP tool handlers
│   ├── execute-sql.ts   # SQL execution handler
│   └── search-objects.ts  # Unified search/list with progressive disclosure
├── utils/               # Shared utilities
│   ├── dsn-obfuscator.ts# DSN security
│   ├── response-formatter.ts # Output formatting
│   └── allowed-keywords.ts  # Read-only SQL validation
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
  - Implemented in `src/server.ts` using `StreamableHTTPServerTransport` with JSON responses
  - Runs in stateless mode (no SSE support) - GET requests to `/mcp` return 405 Method Not Allowed
  - Tests in `src/__tests__/json-rpc-integration.test.ts`
- **Tool Handlers**: Clean separation of MCP protocol concerns
  - Multi-database routing is by tool name, not by parameter: one tool instance is registered per source, named `execute_sql_{source_id}` / `search_objects_{source_id}` (single-source configs keep the bare `execute_sql` / `search_objects` names). See `src/tools/index.ts` and `src/utils/tool-metadata.ts`. `source_id` appears in tool *output* metadata only.
- **Token-Efficient Schema Exploration**: Unified search/list tool with progressive disclosure
  - `search_objects`: Single tool for both pattern-based search and listing all objects
  - Pattern parameter defaults to `%` (match all) - optional for listing use cases
  - Detail levels: `names` (minimal), `summary` (with metadata), `full` (complete structure)
  - Supports: schemas, tables, columns, procedures, indexes
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
- `--config`: Path to TOML configuration file
- `--demo`: Use bundled SQLite employee database
- `--readonly`: Restrict to read-only SQL operations (deprecated - use TOML configuration instead)
- `--max-rows`: Limit rows returned from SELECT queries (deprecated - use TOML configuration instead)
- SSH tunnel options: `--ssh-host`, `--ssh-port`, `--ssh-user`, `--ssh-password`, `--ssh-key`, `--ssh-passphrase`
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
- Implement the `Connector` and `DSNParser` interfaces from `src/interfaces/connector.ts`
- Register connector with `ConnectorRegistry.register(connector)`
- DSN Examples:
  - PostgreSQL: `postgres://user:password@localhost:5432/dbname?sslmode=disable`
  - MySQL: `mysql://user:password@localhost:3306/dbname?sslmode=disable`
  - MariaDB: `mariadb://user:password@localhost:3306/dbname?sslmode=disable`
  - SQL Server: `sqlserver://user:password@localhost:1433/dbname?sslmode=disable`
  - SQL Server (named instance): `sqlserver://user:password@localhost:1433/dbname?instanceName=ENV1`
  - SQL Server (NTLM): `sqlserver://user:password@localhost:1433/dbname?authentication=ntlm&domain=MYDOMAIN`
  - SQLite: `sqlite:///path/to/database.db` or `sqlite:///:memory:`
- SSL modes: `sslmode=disable` (no SSL), `sslmode=require` (SSL without cert verification), `sslmode=verify-ca` (PostgreSQL only, CA verification), `sslmode=verify-full` (PostgreSQL only, CA + hostname verification). Use `sslrootcert` to specify CA certificate path for verify modes.

## Testing Approach

See [TESTING.md](TESTING.md) for comprehensive testing documentation.

For detailed guidance on running and troubleshooting tests, refer to the [testing skill](.claude/skills/testing/SKILL.md). This skill is automatically activated when working with tests, test failures, or Docker/database container issues.

Key points:
- Unit tests for individual components and utilities
- Integration tests using Testcontainers for real database testing
- All connectors have comprehensive integration test coverage
- Pre-commit hooks run related tests automatically
- Test specific databases: `pnpm test src/connectors/__tests__/{db-type}.integration.test.ts`
- SSH tunnel tests: `pnpm test postgres-ssh-simple.integration.test.ts`

## SSH Tunnel Support

DBHub supports SSH tunnels for secure database connections through bastion hosts:

- Configuration via command-line options: `--ssh-host`, `--ssh-port`, `--ssh-user`, `--ssh-password`, `--ssh-key`, `--ssh-passphrase`
- Configuration via environment variables: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`, `SSH_KEY`, `SSH_PASSPHRASE`
- SSH config file support: Automatically reads from `~/.ssh/config` when using host aliases
- Implementation in `src/utils/ssh-tunnel.ts` using the `ssh2` library
- SSH config parsing in `src/utils/ssh-config-parser.ts` using the `ssh-config` library
- Automatic tunnel establishment when SSH config is detected
- Support for both password and key-based authentication
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
