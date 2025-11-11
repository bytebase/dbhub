> [!NOTE]  
> Brought to you by [Bytebase](https://www.bytebase.com/), open-source database DevSecOps platform.

<p align="center">
<a href="https://dbhub.ai/" target="_blank">
<picture>
  <img src="https://raw.githubusercontent.com/bytebase/dbhub/main/resources/images/logo-full.webp" width="75%">
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

## Supported Matrix

### Database Resources

| Resource Name               | URI Format                                             | PostgreSQL | MySQL | MariaDB | SQL Server | SQLite |
| --------------------------- | ------------------------------------------------------ | :--------: | :---: | :-----: | :--------: | :----: |
| schemas                     | `db://schemas`                                         |     ✅     |  ✅   |   ✅    |     ✅     |   ✅   |
| tables_in_schema            | `db://schemas/{schemaName}/tables`                     |     ✅     |  ✅   |   ✅    |     ✅     |   ✅   |
| table_structure_in_schema   | `db://schemas/{schemaName}/tables/{tableName}`         |     ✅     |  ✅   |   ✅    |     ✅     |   ✅   |
| indexes_in_table            | `db://schemas/{schemaName}/tables/{tableName}/indexes` |     ✅     |  ✅   |   ✅    |     ✅     |   ✅   |
| procedures_in_schema        | `db://schemas/{schemaName}/procedures`                 |     ✅     |  ✅   |   ✅    |     ✅     |   ❌   |
| procedure_details_in_schema | `db://schemas/{schemaName}/procedures/{procedureName}` |     ✅     |  ✅   |   ✅    |     ✅     |   ❌   |

### Database Tools

| Tool        | Command Name  | Description                                                         | PostgreSQL | MySQL | MariaDB | SQL Server | SQLite |
| ----------- | ------------- | ------------------------------------------------------------------- | :--------: | :---: | :-----: | :--------: | ------ |
| Execute SQL | `execute_sql` | Execute single or multiple SQL statements (separated by semicolons) |     ✅     |  ✅   |   ✅    |     ✅     | ✅     |

### Prompt Capabilities

| Prompt              | Command Name   | PostgreSQL | MySQL | MariaDB | SQL Server | SQLite |
| ------------------- | -------------- | :--------: | :---: | :-----: | :--------: | ------ |
| Generate SQL        | `generate_sql` |     ✅     |  ✅   |   ✅    |     ✅     | ✅     |
| Explain DB Elements | `explain_db`   |     ✅     |  ✅   |   ✅    |     ✅     | ✅     |

## Installation

### Docker

```bash
# PostgreSQL example
docker run --rm --init \
   --name dbhub \
   --publish 8080:8080 \
   bytebase/dbhub \
   --transport http \
   --port 8080 \
   --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
```

```bash
# Demo mode with sqlite sample employee database
docker run --rm --init \
   --name dbhub \
   --publish 8080:8080 \
   bytebase/dbhub \
   --transport http \
   --port 8080 \
   --demo
```

**Docker Compose Setup:**

If you're using Docker Compose for development, add DBHub to your `docker-compose.yml`:

```yaml
dbhub:
  image: bytebase/dbhub:latest
  container_name: dbhub
  ports:
    - "8080:8080"
  environment:
    - DBHUB_LOG_LEVEL=info
  command:
    - --transport
    - http
    - --port
    - "8080"
    - --dsn
    - "postgres://user:password@database:5432/dbname"
  depends_on:
    - database
```

### NPM

```bash
# PostgreSQL example
npx @bytebase/dbhub --transport http --port 8080 --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"

# Demo mode with sqlite sample employee database
npx @bytebase/dbhub --transport http --port 8080 --demo
```

```bash
# Demo mode with sample employee database
npx @bytebase/dbhub --transport http --port 8080 --demo
```

> Note: The demo mode includes a bundled SQLite sample "employee" database with tables for employees, departments, salaries, and more.

### Claude Desktop

![claude-desktop](https://raw.githubusercontent.com/bytebase/dbhub/main/resources/images/claude-desktop.webp)

- Claude Desktop only supports `stdio` transport https://github.com/orgs/modelcontextprotocol/discussions/16

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "dbhub-postgres-docker": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "bytebase/dbhub",
        "--transport",
        "stdio",
        "--dsn",
        // Use host.docker.internal as the host if connecting to the local db
        "postgres://user:password@host.docker.internal:5432/dbname?sslmode=disable"
      ]
    },
    "dbhub-postgres-npx": {
      "command": "npx",
      "args": [
        "-y",
        "@bytebase/dbhub",
        "--transport",
        "stdio",
        "--dsn",
        "postgres://user:password@localhost:5432/dbname?sslmode=disable"
      ]
    },
    "dbhub-demo": {
      "command": "npx",
      "args": ["-y", "@bytebase/dbhub", "--transport", "stdio", "--demo"]
    }
  }
}
```

### Claude Code

Check https://docs.anthropic.com/en/docs/claude-code/mcp

### Cursor

<p>
Add to Cursor by copying the below link to browser

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=dbhub&config=eyJjb21tYW5kIjoibnB4IEBieXRlYmFzZS9kYmh1YiIsImVudiI6eyJUUkFOU1BPUlQiOiJzdGRpbyIsIkRTTiI6InBvc3RncmVzOi8vdXNlcjpwYXNzd29yZEBsb2NhbGhvc3Q6NTQzMi9kYm5hbWU%2Fc3NsbW9kZT1kaXNhYmxlIiwiUkVBRE9OTFkiOiJ0cnVlIn19
```

</p>

![cursor](https://raw.githubusercontent.com/bytebase/dbhub/main/resources/images/cursor.webp)

- Cursor supports both `stdio` and `http`.
- Follow [Cursor MCP guide](https://docs.cursor.com/context/model-context-protocol) and make sure to use [Agent](https://docs.cursor.com/chat/agent) mode.

### VSCode + Copilot

Check https://code.visualstudio.com/docs/copilot/customization/mcp-servers

VSCode with GitHub Copilot can connect to DBHub via both `stdio` and `http` transports. This enables AI agents to interact with your development database through a secure interface.

- VSCode supports both `stdio` and `http` transports
- Configure MCP server in `.vscode/mcp.json`:

**Stdio Transport:**

```json
{
  "servers": {
    "dbhub": {
      "command": "npx",
      "args": [
        "-y",
        "@bytebase/dbhub",
        "--transport",
        "stdio",
        "--dsn",
        "postgres://user:password@localhost:5432/dbname"
      ]
    }
  },
  "inputs": []
}
```

**HTTP Transport:**

```json
{
  "servers": {
    "dbhub": {
      "url": "http://localhost:8080/mcp",
      "type": "http"
    }
  },
  "inputs": []
}
```

**Copilot Instructions:**

You can provide Copilot with context by creating `.github/copilot-instructions.md`:

```markdown
## Database Access

This project provides an MCP server (DBHub) for secure SQL access to the development database.

AI agents can execute SQL queries. In read-only mode (recommended for production):

- `SELECT * FROM users LIMIT 5;`
- `SHOW TABLES;`
- `DESCRIBE table_name;`

In read-write mode (development/testing):

- `INSERT INTO users (name, email) VALUES ('John', 'john@example.com');`
- `UPDATE users SET status = 'active' WHERE id = 1;`
- `CREATE TABLE test_table (id INT PRIMARY KEY);`

Use `--readonly` flag to restrict to read-only operations for safety.
```

## Usage

### Read-only Mode

You can run DBHub in read-only mode, which restricts SQL query execution to read-only operations:

```bash
# Enable read-only mode
npx @bytebase/dbhub --readonly --dsn "postgres://user:password@localhost:5432/dbname"
```

In read-only mode, only [readonly SQL operations](https://github.com/bytebase/dbhub/blob/main/src/utils/allowed-keywords.ts) are allowed.

This provides an additional layer of security when connecting to production databases.

### Suffix Tool Names with ID

You can suffix tool names with a custom ID using the `--id` flag or `ID` environment variable. This is useful when running multiple DBHub instances (e.g., in Cursor) to allow the client to route queries to the correct database.

**Example configuration for multiple databases in Cursor:**

```json
{
  "mcpServers": {
    "dbhub-prod": {
      "command": "npx",
      "args": ["-y", "@bytebase/dbhub"],
      "env": {
        "ID": "prod",
        "DSN": "postgres://user:password@prod-host:5432/dbname"
      }
    },
    "dbhub-staging": {
      "command": "npx",
      "args": ["-y", "@bytebase/dbhub"],
      "env": {
        "ID": "staging",
        "DSN": "mysql://user:password@staging-host:3306/dbname"
      }
    }
  }
}
```

With this configuration:

- Production database tools: `execute_sql_prod`
- Staging database tools: `execute_sql_staging`

### Multi-Database Configuration (TOML)

**New in v0.11.6+**: DBHub now supports TOML-based configuration files for managing multiple database connections within a single instance. This is the recommended approach for projects that need to query across multiple databases.

#### Quick Start

1. Create a `dbhub.toml` file in your project directory:

```toml
[[sources]]
id = "prod_pg"
dsn = "postgres://user:password@localhost:5432/production"
readonly = false
max_rows = 1000

[[sources]]
id = "staging_mysql"
type = "mysql"
host = "localhost"
port = 3306
database = "staging"
user = "root"
password = "secret"
max_rows = 500
```

2. Run DBHub:

```bash
# Automatically loads ./dbhub.toml
npx @bytebase/dbhub --transport http --port 8080

# Or specify custom config location
npx @bytebase/dbhub --config=/path/to/config.toml --transport http --port 8080
```

#### Configuration Structure

Each database source is defined with `[[sources]]` and requires a unique `id` field:

**Using DSN (recommended):**

```toml
[[sources]]
id = "my_database"
dsn = "postgres://user:pass@localhost:5432/dbname"
readonly = false
max_rows = 1000
```

**Using individual parameters:**

```toml
[[sources]]
id = "my_database"
type = "mysql"            # postgres, mysql, mariadb, sqlserver, sqlite
host = "localhost"
port = 3306
database = "mydb"
user = "root"
password = "secret"
readonly = false
max_rows = 1000
```

**With SSH tunnel:**

```toml
[[sources]]
id = "remote_db"
dsn = "postgres://user:pass@10.0.0.5:5432/dbname"
ssh_host = "bastion.example.com"
ssh_port = 22
ssh_user = "ubuntu"
ssh_key = "~/.ssh/id_rsa"
# ssh_password = "password"  # Alternative to ssh_key
# ssh_passphrase = "key_pass"  # If key is encrypted
```

#### Using Multiple Databases in MCP Tools

When using multi-database configuration, you can specify which database to query using the `source_id` parameter:

```javascript
// Execute SQL on specific database
execute_sql({
  sql: "SELECT * FROM users LIMIT 10",
  source_id: "prod_pg"  // Uses the source with id="prod_pg"
});

// Execute on default database (first in config)
execute_sql({
  sql: "SELECT * FROM orders LIMIT 10"
  // No source_id specified - uses first [[sources]] entry
});
```

#### Configuration Priority

DBHub follows this priority order for configuration:

1. **TOML config file** (e.g., `--config` or `./dbhub.toml`) **OR** **CLI arguments** (e.g., `--dsn`)  
   (These are mutually exclusive: if `--config` is provided, TOML is used; otherwise, `--dsn` is used.)
2. **Environment variables** (e.g., `DSN`)
3. **.env files** (e.g., `.env` or `.env.local`)

**Note**: `--config` (TOML) and `--dsn` (CLI) are alternative primary configuration methods, both taking precedence over environment variables and `.env` files. Users cannot combine `--dsn` with TOML configuration.

#### Example: Complete Multi-Database Setup

See `dbhub.toml.example` in the repository for a comprehensive example with all supported options and detailed comments.

**Key Features:**

- **Default database**: The first `[[sources]]` entry is the default
- **Per-source settings**: Each source can have its own `readonly` and `max_rows` settings
- **Path expansion**: Paths starting with `~/` are expanded to your home directory
- **Security**: Passwords in DSN strings are automatically redacted in logs

#### Backward Compatibility

Single-database configurations using CLI arguments, environment variables, or `.env` files continue to work exactly as before. TOML configuration is optional and only needed for multi-database scenarios.

### Row Limiting

You can limit the number of rows returned from SELECT queries using the `--max-rows` parameter. This helps prevent accidentally retrieving too much data from large tables:

```bash
# Limit SELECT queries to return at most 1000 rows
npx @bytebase/dbhub --dsn "postgres://user:password@localhost:5432/dbname" --max-rows 1000
```

- Row limiting is only applied to SELECT statements, not INSERT/UPDATE/DELETE
- If your query already has a `LIMIT` or `TOP` clause, DBHub uses the smaller value

### SSL Connections

You can specify the SSL mode using the `sslmode` parameter in your DSN string:

| Database   | `sslmode=disable` | `sslmode=require` |   Default SSL Behavior   |
| ---------- | :---------------: | :---------------: | :----------------------: |
| PostgreSQL |        ✅         |        ✅         | Certificate verification |
| MySQL      |        ✅         |        ✅         | Certificate verification |
| MariaDB    |        ✅         |        ✅         | Certificate verification |
| SQL Server |        ✅         |        ✅         | Certificate verification |
| SQLite     |        ❌         |        ❌         |     N/A (file-based)     |

**SSL Mode Options:**

- `sslmode=disable`: All SSL/TLS encryption is turned off. Data is transmitted in plaintext.
- `sslmode=require`: Connection is encrypted, but the server's certificate is not verified. This provides protection against packet sniffing but not against man-in-the-middle attacks. You may use this for trusted self-signed CA.

Without specifying `sslmode`, most databases default to certificate verification, which provides the highest level of security.

Example usage:

```bash
# Disable SSL
postgres://user:password@localhost:5432/dbname?sslmode=disable

# Require SSL without certificate verification
postgres://user:password@localhost:5432/dbname?sslmode=require

# Standard SSL with certificate verification (default)
postgres://user:password@localhost:5432/dbname
```

### SSH Tunnel Support

DBHub supports connecting to databases through SSH tunnels, enabling secure access to databases in private networks or behind firewalls.

#### Using SSH Config File (Recommended)

DBHub can read SSH connection settings from your `~/.ssh/config` file. Simply use the host alias from your SSH config:

```bash
# If you have this in ~/.ssh/config:
# Host mybastion
#   HostName bastion.example.com
#   User ubuntu
#   IdentityFile ~/.ssh/id_rsa

npx @bytebase/dbhub \
  --dsn "postgres://dbuser:dbpass@database.internal:5432/mydb" \
  --ssh-host mybastion
```

DBHub will automatically use the settings from your SSH config, including hostname, user, port, and identity file. If no identity file is specified in the config, DBHub will try common default locations (`~/.ssh/id_rsa`, `~/.ssh/id_ed25519`, etc.).

#### SSH with Password Authentication

```bash
npx @bytebase/dbhub \
  --dsn "postgres://dbuser:dbpass@database.internal:5432/mydb" \
  --ssh-host bastion.example.com \
  --ssh-user ubuntu \
  --ssh-password mypassword
```

#### SSH with Private Key Authentication

```bash
npx @bytebase/dbhub \
  --dsn "postgres://dbuser:dbpass@database.internal:5432/mydb" \
  --ssh-host bastion.example.com \
  --ssh-user ubuntu \
  --ssh-key ~/.ssh/id_rsa
```

#### SSH with Private Key and Passphrase

```bash
npx @bytebase/dbhub \
  --dsn "postgres://dbuser:dbpass@database.internal:5432/mydb" \
  --ssh-host bastion.example.com \
  --ssh-port 2222 \
  --ssh-user ubuntu \
  --ssh-key ~/.ssh/id_rsa \
  --ssh-passphrase mykeypassphrase
```

#### Using Environment Variables

```bash
export SSH_HOST=bastion.example.com
export SSH_USER=ubuntu
export SSH_KEY=~/.ssh/id_rsa
npx @bytebase/dbhub --dsn "postgres://dbuser:dbpass@database.internal:5432/mydb"
```

**Note**: When using SSH tunnels, the database host in your DSN should be the hostname/IP as seen from the SSH server (bastion host), not from your local machine.

### Configure your database connection

You can use DBHub in demo mode with a sample employee database for testing:

```bash
npx @bytebase/dbhub  --demo
```

> [!WARNING]
> If your user/password contains special characters, you have two options:
>
> 1. Escape them in the DSN (e.g. `pass#word` should be escaped as `pass%23word`)
> 2. Use the individual database parameters method below (recommended)

For real databases, you can configure the database connection in two ways:

#### Method 1: Database Source Name (DSN)

- **Command line argument** (highest priority):

  ```bash
  npx @bytebase/dbhub  --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
  ```

- **Environment variable** (second priority):

  ```bash
  export DSN="postgres://user:password@localhost:5432/dbname?sslmode=disable"
  npx @bytebase/dbhub
  ```

- **Environment file** (third priority):
  - For development: Create `.env.local` with your DSN
  - For production: Create `.env` with your DSN
  ```
  DSN=postgres://user:password@localhost:5432/dbname?sslmode=disable
  ```

#### Method 2: Individual Database Parameters

If your password contains special characters that would break URL parsing, use individual environment variables instead:

- **Environment variables**:

  ```bash
  export DB_TYPE=postgres
  export DB_HOST=localhost
  export DB_PORT=5432
  export DB_USER=myuser
  export DB_PASSWORD='my@complex:password/with#special&chars'
  export DB_NAME=mydatabase
  npx @bytebase/dbhub
  ```

- **Environment file**:
  ```
  DB_TYPE=postgres
  DB_HOST=localhost
  DB_PORT=5432
  DB_USER=myuser
  DB_PASSWORD=my@complex:password/with#special&chars
  DB_NAME=mydatabase
  ```

**Supported DB_TYPE values**: `postgres`, `mysql`, `mariadb`, `sqlserver`, `sqlite`

**Default ports** (when DB_PORT is omitted):

- PostgreSQL: `5432`
- MySQL/MariaDB: `3306`
- SQL Server: `1433`

**For SQLite**: Only `DB_TYPE=sqlite` and `DB_NAME=/path/to/database.db` are required.

> [!TIP]
> Use the individual parameter method when your password contains special characters like `@`, `:`, `/`, `#`, `&`, `=` that would break DSN parsing.

> [!WARNING]
> When running in Docker, use `host.docker.internal` instead of `localhost` to connect to databases running on your host machine. For example: `mysql://user:password@host.docker.internal:3306/dbname`

DBHub supports the following database connection string formats:

| Database   | DSN Format                                               | Example                                                                                                        |
| ---------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| MySQL      | `mysql://[user]:[password]@[host]:[port]/[database]`     | `mysql://user:password@localhost:3306/dbname?sslmode=disable`                                                  |
| MariaDB    | `mariadb://[user]:[password]@[host]:[port]/[database]`   | `mariadb://user:password@localhost:3306/dbname?sslmode=disable`                                                |
| PostgreSQL | `postgres://[user]:[password]@[host]:[port]/[database]`  | `postgres://user:password@localhost:5432/dbname?sslmode=disable`                                               |
| SQL Server | `sqlserver://[user]:[password]@[host]:[port]/[database]` | `sqlserver://user:password@localhost:1433/dbname?sslmode=disable`                                              |
| SQLite     | `sqlite:///[path/to/file]` or `sqlite:///:memory:`       | `sqlite:///path/to/database.db`, `sqlite:C:/Users/YourName/data/database.db (windows)` or `sqlite:///:memory:` |

#### SQL Server

Extra query parameters:

#### authentication

- `authentication=azure-active-directory-access-token`. Only applicable when running from Azure. See [DefaultAzureCredential](https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/credential-chains#use-defaultazurecredential-for-flexibility).

### Transport

- **stdio** (default) - for direct integration with tools like Claude Desktop:

  ```bash
  npx @bytebase/dbhub --transport stdio --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
  ```

- **http** - for browser and network clients:
  ```bash
  npx @bytebase/dbhub --transport http --port 5678 --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
  ```

### Command line options

| Option         | Environment Variable | Description                                                           | Default                      |
| -------------- | -------------------- | --------------------------------------------------------------------- | ---------------------------- |
| dsn            | `DSN`                | Database connection string                                            | Required if not in demo mode |
| N/A            | `DB_TYPE`            | Database type: `postgres`, `mysql`, `mariadb`, `sqlserver`, `sqlite`  | N/A                          |
| N/A            | `DB_HOST`            | Database server hostname (not needed for SQLite)                      | N/A                          |
| N/A            | `DB_PORT`            | Database server port (uses default if omitted, not needed for SQLite) | N/A                          |
| N/A            | `DB_USER`            | Database username (not needed for SQLite)                             | N/A                          |
| N/A            | `DB_PASSWORD`        | Database password (not needed for SQLite)                             | N/A                          |
| N/A            | `DB_NAME`            | Database name or SQLite file path                                     | N/A                          |
| transport      | `TRANSPORT`          | Transport mode: `stdio` or `http`                                     | `stdio`                      |
| port           | `PORT`               | HTTP server port (only applicable when using `--transport=http`)      | `8080`                       |
| readonly       | `READONLY`           | Restrict SQL execution to read-only operations                        | `false`                      |
| max-rows       | N/A                  | Limit the number of rows returned from SELECT queries                 | No limit                     |
| demo           | N/A                  | Run in demo mode with sample employee database                        | `false`                      |
| id             | `ID`                 | Instance identifier to suffix tool names (for multi-instance)         | N/A                          |
| ssh-host       | `SSH_HOST`           | SSH server hostname for tunnel connection                             | N/A                          |
| ssh-port       | `SSH_PORT`           | SSH server port                                                       | `22`                         |
| ssh-user       | `SSH_USER`           | SSH username                                                          | N/A                          |
| ssh-password   | `SSH_PASSWORD`       | SSH password (for password authentication)                            | N/A                          |
| ssh-key        | `SSH_KEY`            | Path to SSH private key file                                          | N/A                          |
| ssh-passphrase | `SSH_PASSPHRASE`     | Passphrase for SSH private key                                        | N/A                          |

The demo mode uses an in-memory SQLite database loaded with the [sample employee database](https://github.com/bytebase/dbhub/tree/main/resources/employee-sqlite) that includes tables for employees, departments, titles, salaries, department employees, and department managers. The sample database includes SQL scripts for table creation, data loading, and testing.

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
