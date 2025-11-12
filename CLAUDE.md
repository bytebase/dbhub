# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# DBHub Development Guidelines

DBHub is a Universal Database MCP Server implementing the Model Context Protocol (MCP) server interface. It bridges MCP-compatible clients (Claude Desktop, Claude Code, Cursor) with various database systems.

## Commands

- Build: `pnpm run build` - Compiles TypeScript to JavaScript using tsup
- Start: `pnpm run start` - Runs the compiled server
- Dev: `pnpm run dev` - Runs server with tsx (no compilation needed)
- Test: `pnpm test` - Run all tests
- Test Watch: `pnpm test:watch` - Run tests in watch mode
- Integration Tests: `pnpm test:integration` - Run database integration tests (requires Docker)

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
├── resources/           # MCP resource handlers (DB exploration)
│   ├── schemas.ts       # Schema listing
│   ├── tables.ts        # Table exploration
│   ├── indexes.ts       # Index information
│   └── procedures.ts    # Stored procedures
├── tools/               # MCP tool handlers
│   └── execute-sql.ts   # SQL execution handler
├── prompts/             # AI prompt handlers
│   ├── generate-sql.ts  # SQL generation
│   └── explain-db.ts    # Database explanation
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
  - `getCurrentConnector(sourceId?)` static method for tool/resource handlers
  - Backward compatible with single-connection mode
  - Location: `src/connectors/manager.ts`
- **Transport Abstraction**: Support for both stdio (desktop tools) and HTTP (network clients)
  - HTTP transport endpoint: `/mcp` (aligns with official MCP SDK standard)
  - Implemented in `src/server.ts` using `StreamableHTTPServerTransport`
  - Tests in `src/__tests__/json-rpc-integration.test.ts`
- **Resource/Tool/Prompt Handlers**: Clean separation of MCP protocol concerns
  - Tools accept optional `source_id` parameter for multi-database routing
  - Resources use default (first) database only
- **Integration Test Base**: Shared test utilities for consistent connector testing

## Configuration

DBHub supports three configuration methods (in priority order):

### 1. TOML Configuration File (Multi-Database)
**Recommended for projects requiring multiple database connections**

- Create `dbhub.toml` in your project directory or use `--config=path/to/config.toml`
- Configuration structure uses `[[sources]]` array with unique `id` fields
- Example:
  ```toml
  [[sources]]
  id = "prod_pg"
  dsn = "postgres://user:pass@localhost:5432/production"
  readonly = true
  max_rows = 1000

  [[sources]]
  id = "staging_mysql"
  type = "mysql"
  host = "localhost"
  database = "staging"
  user = "root"
  password = "secret"
  ```
- Key files:
  - `src/types/config.ts`: TypeScript interfaces for TOML structure
  - `src/config/toml-loader.ts`: TOML parsing and validation
  - `src/config/__tests__/toml-loader.test.ts`: Comprehensive test suite
- Features:
  - Per-source SSH tunnel configuration (inline: `ssh_host`, `ssh_user`, `ssh_key`, etc.)
  - Per-source execution options (`readonly`, `max_rows`)
  - Path expansion for `~/` in file paths
  - Automatic password redaction in logs
  - First source is the default database
- Usage in MCP tools: Add optional `source_id` parameter (e.g., `execute_sql(sql, source_id="prod_pg")`)
- See `dbhub.toml.example` for complete configuration reference

### 2. Environment Variables (Single Database)
- Copy `.env.example` to `.env` and configure for your database connection
- Two ways to configure:
  - Set `DSN` to a full connection string (recommended)
  - Set individual parameters: `DB_TYPE`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- SSH tunnel via environment: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`, `SSH_KEY`, `SSH_PASSPHRASE`

### 3. Command-Line Arguments (Single Database, Highest Priority)
- `--dsn`: Database connection string
- `--transport`: `stdio` (default) or `http` for streamable HTTP transport (endpoint: `/mcp`)
- `--port`: HTTP server port (default: 8080)
- `--config`: Path to TOML configuration file
- `--demo`: Use bundled SQLite employee database
- `--readonly`: Restrict to read-only SQL operations
- `--max-rows`: Limit rows returned from SELECT queries
- SSH tunnel options: `--ssh-host`, `--ssh-port`, `--ssh-user`, `--ssh-password`, `--ssh-key`, `--ssh-passphrase`

### Configuration Priority Order
1. Command-line arguments (highest)
2. TOML config file (if present)
3. Environment variables
4. `.env` files (`.env.local` in development, `.env` in production)

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
  - SQLite: `sqlite:///path/to/database.db` or `sqlite:///:memory:`
- SSL modes: `sslmode=disable` (no SSL) or `sslmode=require` (SSL without cert verification)

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
