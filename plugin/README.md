# DBHub Claude Code Plugin

Claude Code plugin for [DBHub](https://dbhub.ai) — a minimal, token-efficient database MCP server for PostgreSQL, MySQL, MariaDB, SQL Server, and SQLite. Full guide: https://dbhub.ai/claude-code-plugin

## What's included

- **MCP server**: registers `dbhub` (via `npx @bytebase/dbhub`, pinned to this plugin's version) exposing two tools: `execute_sql` and `search_objects`.
- **`/dbhub:setup`**: skill that helps you build the connection string, troubleshoot connection failures, and graduate to a multi-database TOML config when needed.
- **`/dbhub:explore`**: teaches Claude the token-efficient progressive-disclosure workflow for exploring schemas (`names` → `summary` → `full`).

## Installation

Inside Claude Code (the repo doubles as a plugin marketplace via `.claude-plugin/marketplace.json`):

```
/plugin marketplace add bytebase/dbhub
/plugin install dbhub@dbhub
```

For development on the plugin itself, load it from a checkout instead: `claude --plugin-dir ./plugin`.

Claude Code prompts for your database connection string (DSN) on install and stores it in secure storage, e.g. `postgres://user:password@localhost:5432/dbname` — run `/dbhub:setup` for help building one. To change it later, open `/plugin` → dbhub → configuration.

## Read-only by design

Like the [MCPB bundle](https://dbhub.ai/mcpb), this plugin ships a fixed read-only configuration (`dbhub.toml`): mutating statements are rejected by the SQL classifier, the database session is set read-only at the engine level, and results are capped at 1000 rows. Pair it with a least-privilege, read-only database account.

Need write access, multiple databases, SSH tunnels, or custom tools? Register DBHub directly with your own [TOML config](https://dbhub.ai/config/toml) instead:

```bash
claude mcp add dbhub -- npx -y @bytebase/dbhub@latest --transport stdio --config /path/to/dbhub.toml
```

## Requirements

- Node.js >= 22.5.0 (`npx` fetches the `@bytebase/dbhub` package on first launch)
