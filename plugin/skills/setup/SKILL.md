---
description: Connect DBHub to a database or fix a failing connection; also covers changing the DSN, write access, or multiple databases.
---

# DBHub Setup

The database connection string (DSN) is entered in the plugin's configuration dialog and stored in Claude Code's secure storage. This plugin is read-only and caps results at 1000 rows.

## Connecting or changing the database

1. **Help the user build their DSN** if they don't have one:
   - PostgreSQL: `postgres://user:password@localhost:5432/dbname`
   - MySQL: `mysql://user:password@localhost:3306/dbname`
   - MariaDB: `mariadb://user:password@localhost:3306/dbname`
   - SQL Server: `sqlserver://user:password@localhost:1433/dbname`
   - SQLite: `sqlite:///absolute/path/to/database.db` (no credentials)

   Append `?sslmode=require` for SSL (`sslmode=disable` for local databases). URL-encode special characters in the password. Recommend a least-privilege, read-only database account. Full DSN options (SQL Server named instances/NTLM, PostgreSQL cert verification): https://dbhub.ai/installation

2. **Point them at the config dialog:** run `/plugin`, open **dbhub** → configuration, and set the connection string there. The user should not paste the password into the chat.

3. **Reconnect:** run `/mcp` and reconnect the `dbhub` server (or restart Claude Code).

## Troubleshooting a failing connection

- Test the DSN outside the plugin (redact the password in anything shown in chat):
  ```bash
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"setup-check","version":"0"}}}' | DBHUB_DSN='<dsn>' npx -y @bytebase/dbhub@latest --transport stdio --config <plugin-root>/dbhub.toml
  ```
  A JSON `initialize` response means the config parsed and the server started; a connection error points at host/port/credentials/SSL.
- Common causes: database unreachable from this machine (host/port, VPN, firewall), wrong `sslmode`, un-encoded special characters in the password, a SQLite path that isn't absolute.
- Requires Node.js >= 22.5.0 (`node --version`).

## When this plugin isn't enough

The plugin covers one database, read-only. For write access, multiple databases, SSH tunnels, or custom tools, register DBHub directly with your own TOML config:

```bash
claude mcp add dbhub -- npx -y @bytebase/dbhub@latest --transport stdio --config /path/to/dbhub.toml
```

Offer to write that TOML for the user — format reference: https://dbhub.ai/config/toml. Suggest disabling this plugin's server afterwards to avoid two overlapping DBHub instances.
