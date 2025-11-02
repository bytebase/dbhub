# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# DBHub Development Guidelines

DBHub is a Universal Database Gateway implementing the Model Context Protocol (MCP) server interface. It bridges MCP-compatible clients (Claude Desktop, Claude Code, Cursor) with various database systems.

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
- **Transport Abstraction**: Support for both stdio (desktop tools) and HTTP (network clients)
  - HTTP transport endpoint: `/mcp` (aligns with official MCP SDK standard)
  - Implemented in `src/server.ts` using `StreamableHTTPServerTransport`
  - Tests in `src/__tests__/json-rpc-integration.test.ts`
- **Resource/Tool/Prompt Handlers**: Clean separation of MCP protocol concerns
- **Integration Test Base**: Shared test utilities for consistent connector testing

## Environment

- Copy `.env.example` to `.env` and configure for your database connection
- Two ways to configure:
  - Set `DSN` to a full connection string (recommended)
  - Set `DB_CONNECTOR_TYPE` to select a connector with its default DSN
- Transport options:
  - Set `--transport=stdio` (default) for stdio transport
  - Set `--transport=http` for streamable HTTP transport with HTTP server (endpoint: `/mcp`)
- Demo mode: Use `--demo` flag for bundled SQLite employee database
- Read-only mode: Use `--readonly` flag to restrict to read-only SQL operations

## Database Connectors

- Add new connectors in `src/connectors/{db-type}/index.ts`
- Implement the `Connector` and `DSNParser` interfaces from `src/interfaces/connector.ts`
- Register connector with `ConnectorRegistry.register(connector)`
- DSN Examples:
  - PostgreSQL: `postgres://user:password@localhost:5432/dbname?sslmode=disable`
  - MySQL: `mysql://user:password@localhost:3306/dbname?sslmode=disable`
  - MariaDB: `mariadb://user:password@localhost:3306/dbname?sslmode=disable`
  - SQL Server: `sqlserver://user:password@localhost:1433/dbname?sslmode=disable`
  - SQLite: `sqlite:///path/to/database.db` or `sqlite:///:memory:`
- SSL modes: `sslmode=disable` (no SSL) or `sslmode=require` (SSL without cert verification)

## Testing Approach

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
