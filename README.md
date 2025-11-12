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

![Star History Chart](https://api.star-history.com/svg?repos=bytebase/dbhub&type=Date)

</p>

DBHub is a Universal Database MCP Server implementing the Model Context Protocol (MCP) server interface. This gateway allows MCP-compatible clients to connect to and explore different databases.

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

## Supported Databases

PostgreSQL, MySQL, SQL Server, MariaDB, and SQLite.

## MCP Components

DBHub implements MCP Resources, Tools, and Prompts for database operations:

- **[Resources](https://dbhub.ai/components/resources)**: Database schema exploration (schemas, tables, indexes, procedures)
- **[Tools](https://dbhub.ai/components/tools)**: SQL execution with transaction support
- **[Prompts](https://dbhub.ai/components/prompts)**: AI-assisted SQL generation and database explanation

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
npx @bytebase/dbhub --transport http --port 8080 --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable" --demo
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

The project uses Vitest for comprehensive unit and integration testing:

- **Run all tests**: `pnpm test`
- **Run tests in watch mode**: `pnpm test:watch`
- **Run integration tests**: `pnpm test:integration`

#### Integration Tests

DBHub includes comprehensive integration tests for all supported database connectors using [Testcontainers](https://testcontainers.com/). These tests run against real database instances in Docker containers, ensuring full compatibility and feature coverage.

##### Prerequisites

- **Docker**: Ensure Docker is installed and running on your machine
- **Docker Resources**: Allocate sufficient memory (recommended: 4GB+) for multiple database containers
- **Network Access**: Ability to pull Docker images from registries

##### Running Integration Tests

**Note**: This command runs all integration tests in parallel, which may take 5-15 minutes depending on your system resources and network speed.

```bash
# Run all database integration tests
pnpm test:integration
```

```bash
# Run only PostgreSQL integration tests
pnpm test src/connectors/__tests__/postgres.integration.test.ts
# Run only MySQL integration tests
pnpm test src/connectors/__tests__/mysql.integration.test.ts
# Run only MariaDB integration tests
pnpm test src/connectors/__tests__/mariadb.integration.test.ts
# Run only SQL Server integration tests
pnpm test src/connectors/__tests__/sqlserver.integration.test.ts
# Run only SQLite integration tests
pnpm test src/connectors/__tests__/sqlite.integration.test.ts
# Run JSON RPC integration tests
pnpm test src/__tests__/json-rpc-integration.test.ts
```

All integration tests follow these patterns:

1. **Container Lifecycle**: Start database container → Connect → Setup test data → Run tests → Cleanup
2. **Shared Test Utilities**: Common test patterns implemented in `IntegrationTestBase` class
3. **Database-Specific Features**: Each database includes tests for unique features and capabilities
4. **Error Handling**: Comprehensive testing of connection errors, invalid SQL, and edge cases

##### Troubleshooting Integration Tests

**Container Startup Issues:**

```bash
# Check Docker is running
docker ps

# Check available memory
docker system df

# Pull images manually if needed
docker pull postgres:15-alpine
docker pull mysql:8.0
docker pull mariadb:10.11
docker pull mcr.microsoft.com/mssql/server:2019-latest
```

**SQL Server Timeout Issues:**

- SQL Server containers require significant startup time (3-5 minutes)
- Ensure Docker has sufficient memory allocated (4GB+ recommended)
- Consider running SQL Server tests separately if experiencing timeouts

**Network/Resource Issues:**

```bash
# Run tests with verbose output
pnpm test:integration --reporter=verbose

# Run single database test to isolate issues
pnpm test:integration -- --testNamePattern="PostgreSQL"

# Check Docker container logs if tests fail
docker logs <container_id>
```

### Debug with [MCP Inspector](https://github.com/modelcontextprotocol/inspector)

![mcp-inspector](https://raw.githubusercontent.com/bytebase/dbhub/main/resources/images/mcp-inspector.webp)

#### stdio

```bash
# PostgreSQL example
TRANSPORT=stdio DSN="postgres://user:password@localhost:5432/dbname?sslmode=disable" npx @modelcontextprotocol/inspector node /path/to/dbhub/dist/index.js
```

#### HTTP

```bash
# Start DBHub with HTTP transport
pnpm dev --transport=http --port=8080

# Start the MCP Inspector in another terminal
npx @modelcontextprotocol/inspector
```

Connect to the DBHub server `/mcp` endpoint

## Contributors

<a href="https://github.com/bytebase/dbhub/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=bytebase/dbhub" />
</a>
