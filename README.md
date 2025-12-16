> [!NOTE]  
> Brought to you by [Bytebase](https://www.bytebase.com/), open-source database DevSecOps platform.

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
            |                  |    |              |    |                  |
            |  Claude Desktop  +--->+              +--->+    PostgreSQL    |
            |                  |    |              |    |                  |
            |  Claude Code     +--->+              +--->+    SQL Server    |
            |                  |    |              |    |                  |
            |  Cursor          +--->+    DBHub     +--->+    SQLite        |
            |                  |    |              |    |                  |
            |  VS Code         +--->+              +--->+    MySQL         |
            |                  |    |              |    |                  |
            |  Other Clients   +--->+              +--->+    MariaDB       |
            |                  |    |              |    |                  |
            |                  |    |              |    |                  |
            +------------------+    +--------------+    +------------------+
                 MCP Clients           MCP Server             Databases
```

DBHub is a Minimal Database MCP Server implementing the Model Context Protocol (MCP) server interface. This lightweight gateway allows MCP-compatible clients to connect to and explore different databases:

- **Minimal Design**: Just two general MCP tools (execute_sql, search_objects) for token-efficient operations, plus support for custom tools
- **Multi-Database Support**: Single interface for PostgreSQL, MySQL, MariaDB, SQL Server, and SQLite
- **Secure Access**: Read-only mode, SSH tunneling, and SSL/TLS encryption support
- **Multiple Connections**: Connect to multiple databases simultaneously with TOML configuration
- **Production-Ready**: Row limiting, lock timeout control, and connection pooling
- **MCP Native**: Full implementation of Model Context Protocol with comprehensive tools

## Supported Databases

PostgreSQL, MySQL, SQL Server, MariaDB, and SQLite.

## MCP Tools

DBHub implements MCP tools for database operations:

- **[execute_sql](https://dbhub.ai/tools/execute-sql)**: Execute SQL queries with transaction support and safety controls
- **[search_objects](https://dbhub.ai/tools/search-objects)**: Search and explore database schemas, tables, columns, indexes, and procedures with progressive disclosure
- **[Custom Tools](https://dbhub.ai/tools/custom-tools)**: Define reusable, parameterized SQL operations in your `dbhub.toml` configuration file

## Installation

See the full [Installation Guide](https://dbhub.ai/installation) for detailed instructions.

### Quick Start

**Docker:**

```bash
docker run --rm --init \
   --name dbhub \
   --publish 8080:8080 \
   bytebase/dbhub \
   --transport http \
   --port 8080 \
   --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
```

**NPM:**

```bash
npx @bytebase/dbhub --transport http --port 8080 --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
```

**Demo Mode:**

```bash
npx @bytebase/dbhub --transport http --port 8080 --demo
```

See [Server Options](https://dbhub.ai/config/server-options) for all available parameters.

### Multi-Database Setup

Connect to multiple databases simultaneously using TOML configuration files. Perfect for managing production, staging, and development databases from a single DBHub instance.

See [Multi-Database Configuration](https://dbhub.ai/config/multi-database) for complete setup instructions.

## Development

1. Install dependencies:

   ```bash
   pnpm install
   ```

1. Run in development mode:

   ```bash
   pnpm dev
   ```

1. Build for production:
   ```bash
   pnpm build
   pnpm start --transport stdio --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
   ```

### Testing

See [TESTING.md](.claude/skills/testing/SKILL.md).

### Debug

See [Debug](https://dbhub.ai/config/debug).

## Contributors

<a href="https://github.com/bytebase/dbhub/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=bytebase/dbhub" />
</a>

## Star History

![Star History Chart](https://api.star-history.com/svg?repos=bytebase/dbhub&type=Date)
