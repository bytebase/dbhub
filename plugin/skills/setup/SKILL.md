---
name: setup
description: Connect DBHub to a database or fix a failing connection; also covers changing the DSN, write access, or multiple databases.
---

# DBHub Setup

This plugin runs DBHub read-only and caps results at 1000 rows. Where the database connection string (DSN) lives depends on the host you are running in:

- **Claude Code:** entered in the plugin's configuration dialog and stored in Claude Code's secure storage.
- **Codex:** read from the `DBHUB_DSN` environment variable of the environment Codex is started in.

## Connecting or changing the database

1. **Help the user build their DSN** if they don't have one:
   - PostgreSQL: `postgres://user:password@localhost:5432/dbname`
   - MySQL: `mysql://user:password@localhost:3306/dbname`
   - MariaDB: `mariadb://user:password@localhost:3306/dbname`
   - SQL Server: `sqlserver://user:password@localhost:1433/dbname`
   - Oracle: `oracle://user:password@localhost:1521/FREEPDB1` (path is the service name)
   - ClickHouse: `clickhouse://user:password@localhost:8123/dbname` (the HTTP port; `8443` with `?sslmode=require` for ClickHouse Cloud)
   - SQLite: `sqlite:///absolute/path/to/database.db` (no credentials)

   Append `?sslmode=require` for SSL (`sslmode=disable` for local databases). URL-encode special characters in the password. Recommend a least-privilege, read-only database account. Full DSN options (SQL Server named instances/NTLM, PostgreSQL cert verification): https://dbhub.ai/installation

2. **Have the user set it themselves** — they should not paste the password into the chat:
   - **Claude Code:** run `/plugin`, open **dbhub** → configuration, and set the connection string there.
   - **Codex:** add `export DBHUB_DSN='<dsn>'` to their shell profile (e.g. `~/.zshrc`), then start Codex from a new shell so it inherits the variable.

3. **Reconnect:**
   - **Claude Code:** run `/mcp` and reconnect the `dbhub` server (or restart Claude Code).
   - **Codex:** restart Codex, then check the `dbhub` server with `/mcp`.

## Troubleshooting a failing connection

- The server exiting at startup with `references unset environment variable(s): DBHUB_DSN` means the DSN never reached it. In Codex, `DBHUB_DSN` is not set in the environment Codex was started from (a desktop app may not inherit your shell profile — if so, register DBHub directly as described in the last section).
- Test the DSN outside the plugin (redact the password in anything shown in chat):
  ```bash
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"setup-check","version":"0"}}}' | DBHUB_DSN='<dsn>' npx -y @bytebase/dbhub@latest --transport stdio --config <plugin-root>/dbhub.toml
  ```
  A JSON `initialize` response means the config parsed and the server started; a connection error points at host/port/credentials/SSL.
- Common causes: database unreachable from this machine (host/port, VPN, firewall), wrong `sslmode`, un-encoded special characters in the password, a SQLite path that isn't absolute.
- If the server dies instantly with `sh: dbhub: command not found`, or npm reports a missing `package.json` under `~/.npm/_npx/`, the npx cache entry is corrupted (concurrent or interrupted npx runs can leave it half-installed). Find and remove the entry for `@bytebase/dbhub` under `~/.npm/_npx/*/`, then reconnect — npx will reinstall it cleanly.
- The first launch downloads the package and can take a minute; if the server times out once, reconnect.
- Requires Node.js >= 22.5.0 (`node --version`).

## When this plugin isn't enough

The plugin covers one database, read-only. For write access, multiple databases, SSH tunnels, or custom tools, register DBHub directly with your own TOML config:

```bash
# Claude Code
claude mcp add dbhub -- npx -y @bytebase/dbhub@latest --transport stdio --config /path/to/dbhub.toml

# Codex
codex mcp add dbhub -- npx -y @bytebase/dbhub@latest --transport stdio --config /path/to/dbhub.toml
```

Offer to write that TOML for the user — format reference: https://dbhub.ai/config/toml. Suggest disabling this plugin afterwards to avoid two overlapping DBHub instances.
