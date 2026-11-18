# DBHub Plugin for Claude Code and Codex

Plugin for [DBHub](https://dbhub.ai) — a minimal, token-efficient database MCP server for PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, and SQLite. One directory serves both hosts: Claude Code reads `.claude-plugin/plugin.json` + `.mcp.json`, Codex reads `.codex-plugin/plugin.json` + `mcp.codex.json`. Full guides: https://dbhub.ai/claude-code-plugin and https://dbhub.ai/codex-plugin

## What's included

- **MCP server**: registers `dbhub` (via `npx @bytebase/dbhub`, pinned to this plugin's version) exposing two tools: `execute_sql` and `search_objects`.
- **`dbhub:setup`**: skill that helps you build the connection string, troubleshoot connection failures, and graduate to a multi-database TOML config when needed.
- **`dbhub:explore`**: teaches the agent the token-efficient progressive-disclosure workflow for exploring schemas (`names` → `summary` → `full`).

## Installation

### Claude Code

Inside Claude Code (the repo doubles as a plugin marketplace via `.claude-plugin/marketplace.json`):

```
/plugin marketplace add bytebase/dbhub
/plugin install dbhub@dbhub
```

For development on the plugin itself, load it from a checkout instead: `claude --plugin-dir ./plugin`.

Claude Code prompts for your database connection string (DSN) on install and stores it in secure storage, e.g. `postgres://user:password@localhost:5432/dbname` — run `/dbhub:setup` for help building one. To change it later, open `/plugin` → dbhub → configuration.

### Codex

The repo is also a Codex marketplace (`.agents/plugins/marketplace.json`):

```bash
codex plugin marketplace add bytebase/dbhub
codex plugin add dbhub@dbhub
```

Codex has no install-time prompt, so the plugin reads the DSN from the `DBHUB_DSN` environment variable of the environment Codex starts in — e.g. `export DBHUB_DSN="postgres://user:password@localhost:5432/dbname"` in your shell profile. For development, add a checkout as a local marketplace: `codex plugin marketplace add /path/to/dbhub`.

## Read-only by design

Like the [MCPB bundle](https://dbhub.ai/mcpb), this plugin ships a fixed read-only configuration (`dbhub.toml`): mutating statements are rejected by the SQL classifier, the database session is set read-only at the engine level, and results are capped at 1000 rows. Pair it with a least-privilege, read-only database account.

Need write access, multiple databases, SSH tunnels, or custom tools? Register DBHub directly with your own [TOML config](https://dbhub.ai/config/toml) instead:

```bash
# Claude Code
claude mcp add dbhub -- npx -y @bytebase/dbhub@latest --transport stdio --config /path/to/dbhub.toml

# Codex
codex mcp add dbhub -- npx -y @bytebase/dbhub@latest --transport stdio --config /path/to/dbhub.toml
```

## Requirements

- Node.js >= 22.5.0 (`npx` fetches the `@bytebase/dbhub` package on first launch)
