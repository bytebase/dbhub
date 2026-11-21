> [!NOTE]  
> If you need an enterprise-level database MCP server with built-in guardrails like approval flow, access control, data masking, and audit logging beyond what DBHub offers, check out [Bytebase](https://www.bytebase.com/).

<p align="center">
<a href="https://code.claude.com/docs/en/mcp#example-query-your-postgresql-database"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/featured-by-claude-code-dark.svg" /><source media="(prefers-color-scheme: light)" srcset="docs/images/featured-by-claude-code-light.svg" /><img alt="Featured in the official Claude Code docs — read the DBHub example" src="docs/images/featured-by-claude-code-light.svg" width="280" height="64" /></picture></a>
</p>

<p align="center">
<a href="https://dbhub.ai/" target="_blank">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-dark.svg" width="75%">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-light.svg" width="75%">
  <img src="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-light.svg" width="75%" alt="DBHub Logo">
</picture>
</a>
</p>

```bash
            +------------------+    +--------------+    +------------------+
            |                  |    |              |    |                  |
            |  Claude Desktop  +--->+              +--->+    PostgreSQL    |
            |                  |    |              |    |                  |
            |  Claude Code     +--->+              +--->+    SQL Server    |
            |                  |    |              |    |                  |
            |  Codex           +--->+    DBHub     +--->+    Oracle        |
            |                  |    |              |    |                  |
            |  Cursor          +--->+              +--->+    SQLite        |
            |                  |    |              |    |                  |
            |  VS Code         +--->+              +--->+    MySQL         |
            |                  |    |              |    |                  |
            |  Copilot CLI     +--->+              +--->+    MariaDB       |
            |                  |    |              |    |                  |
            |                  |    |              +--->+    ClickHouse    |
            |                  |    |              |    |                  |
            +------------------+    +--------------+    +------------------+
                 MCP Clients           MCP Server             Databases
```

DBHub is a minimal MCP server: token-efficient, zero-dependency, and just two tools by default with opt-in extras. This lightweight gateway allows MCP-compatible clients to connect to and explore different databases:

- **Minimal**: Zero dependency, token efficient with a minimal set of MCP tools to maximize context window
- **Multi-Database**: PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, ClickHouse, and SQLite through a single interface
- **Multi-Connection**: Connect to multiple databases simultaneously with TOML configuration
- **Guardrails**: Read-only mode, row limiting, and query timeout to prevent runaway operations
- **Secure Access**: SSH tunneling and SSL/TLS encryption

<p align="center">
 <img src="docs/images/community-logo-wall.png" alt="Our community includes developers from 30 companies and 10 universities, including Microsoft, NVIDIA, Amazon, Google, Oxford, Cornell, Duke, Tsinghua, Peking, KAIST, UBC, and Waseda." width="100%" />
</p>

## Token Efficiency

DBHub's two built-in tool definitions total **261 tokens** with the `cl100k_base` tokenizer.

| MCP Server | Definition Tokens | Tools |
|------------|-------------------|-------|
| **DBHub 2.0.1** | **261** | 2 |
| MCP Toolbox 1.18.0 | 3,901 | 29 |
| Supabase MCP 0.19.0 | 6,982 | 36 |

Full tool definitions, not session usage. See the [November 2026 benchmark](https://dbhub.ai/blog/database-mcp-server-token-benchmark-2026) for configurations and reproduction steps.

## Use Cases

- **Local Development**: Schema exploration, query validation, and data debugging with Claude Code, VS Code, Cursor, etc.
- **Non-Technical Access**: Expose curated, read-only views to non-technical staff via Claude Desktop, VS Code, Cursor, etc.
- **Multi-Database Consolidation**: Replace separate MCP servers for each database with a single DBHub process
- **Production Troubleshooting**: Read-only diagnostics with guardrails against runaway queries

> Read-only mode is a guardrail, not a permission boundary. Always connect with a least-privilege, read-only database user. See [Read-Only Mode](https://dbhub.ai/config/read-only-mode).

## Supported Databases

PostgreSQL, MySQL, SQL Server, MariaDB, Oracle, ClickHouse, and SQLite.

## MCP Tools

DBHub implements MCP tools for database operations:

- **[execute_sql](https://dbhub.ai/tools/execute-sql)**: Execute SQL queries with transaction support and safety controls
- **[search_objects](https://dbhub.ai/tools/search-objects)**: Search and explore database schemas, tables, columns, indexes, and procedures with progressive disclosure
- **[explain_sql](https://dbhub.ai/tools/explain-sql)** (opt-in): Show a query's execution plan without running it
- **[health_check](https://dbhub.ai/tools/health-check)** (opt-in): Report connection pool state and buffer cache hit ratio
- **[Custom Tools](https://dbhub.ai/tools/custom-tools)**: Define reusable, parameterized SQL operations in your `dbhub.toml` configuration file

## Workbench

DBHub includes a [built-in web interface](https://dbhub.ai/workbench/overview) for interacting with your database tools. It provides a visual way to execute queries, run custom tools, and view request traces without requiring an MCP client.

<table>
  <tr>
    <td colspan="2">
      <strong>Workbench overview</strong><br /><br />
      <a href="docs/images/workbench/workbench.webp"><img src="docs/images/workbench/workbench.webp" alt="DBHub Workbench showing connection details and available tools" width="100%" /></a>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Execute SQL</strong><br /><br />
      <a href="docs/images/workbench/execute-sql.webp"><img src="docs/images/workbench/execute-sql.webp" alt="SQL editor showing an employee query and its results" width="100%" /></a>
    </td>
    <td width="50%" valign="top">
      <strong>Request traces</strong><br /><br />
      <a href="docs/images/workbench/request-trace.webp"><img src="docs/images/workbench/request-trace.webp" alt="Recent SQL requests with execution times and client details" width="100%" /></a>
    </td>
  </tr>
</table>

## Installation

```bash
npx @bytebase/dbhub@latest --transport http --port 8080 --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
```

For Claude Code, install the [plugin](https://dbhub.ai/claude-code-plugin):

```
/plugin marketplace add bytebase/dbhub
/plugin install dbhub@dbhub
```

For Codex, install the [plugin](https://dbhub.ai/codex-plugin) (reads the connection string from `DBHUB_DSN`):

```bash
codex plugin marketplace add bytebase/dbhub
codex plugin add dbhub@dbhub
```

Also available as:

- [Docker image](https://dbhub.ai/installation#docker)
- [MCP Bundle](https://dbhub.ai/mcpb) (one-click install, read-only)

See the [Installation Guide](https://dbhub.ai/installation) for all options, [Command-Line Options](https://dbhub.ai/config/command-line) for parameters, and [Multi-Database Configuration](https://dbhub.ai/config/toml) for connecting several databases at once.

## Replacing `@modelcontextprotocol/server-postgres`

The reference PostgreSQL MCP server, `@modelcontextprotocol/server-postgres`, is archived and marked deprecated on npm ("Archived and unmaintained; no security guarantees"). DBHub is a maintained replacement. Swap the package and pass the connection string with `--dsn`; an existing `postgresql://` URL works unchanged.

Before:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    }
  }
}
```

After:

```json
{
  "mcpServers": {
    "dbhub": {
      "command": "npx",
      "args": ["-y", "@bytebase/dbhub@latest", "--dsn", "postgresql://localhost/mydb"]
    }
  }
}
```

The old server only ran read-only queries. With `--dsn` alone, DBHub's `execute_sql` can also write. To keep it read-only, point `--config` at a TOML file that sets `readonly = true`. The [replacement guide](https://dbhub.ai/blog/modelcontextprotocol-server-postgres-alternative) has that config and the other differences.

## Development

Requires Node.js >= 22.5.0 (DBHub uses the built-in `node:sqlite` module).

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build and run for production
pnpm build && pnpm start --transport stdio --dsn "postgres://user:password@localhost:5432/dbname"
```

See [Testing](.claude/skills/testing/SKILL.md) and [Debug](https://dbhub.ai/config/debug).

See the [branding guide](BRANDING.md) for logo assets, the Zinc color theme, and the asset sync workflow.

## Contributors

<a href="https://github.com/bytebase/dbhub/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=bytebase/dbhub" />
</a>

## Star History

<a href="https://www.star-history.com/?repos=bytebase%2Fdbhub&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bytebase/dbhub&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bytebase/dbhub&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bytebase/dbhub&type=date&legend=top-left" />
 </picture>
</a>
