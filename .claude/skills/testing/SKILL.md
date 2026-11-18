---
name: testing
description: Run and troubleshoot tests for DBHub, including unit tests, integration tests with Testcontainers, and database-specific tests. Use when asked to run tests, fix test failures, debug integration tests, troubleshoot Docker/database container issues, or add new tests. Also use when verifying code changes work correctly or when CI test failures need investigation.
---

# Testing Skill

This skill helps you run, write, and troubleshoot tests in the DBHub project.

## Test Commands

```bash
pnpm test              # Run all tests (unit + integration)
pnpm test:unit         # Unit tests only (no Docker needed)
pnpm test:watch        # Interactive watch mode
pnpm test:integration  # Integration tests only (requires Docker)
pnpm test:build        # After `pnpm run build`: import every connector chunk in dist/
pnpm test:mcpb         # After `pnpm run build:mcpb`: smoke-test the packed bundle over stdio
```

Run a specific test file:
```bash
pnpm test src/connectors/__tests__/postgres.integration.test.ts
pnpm test src/utils/__tests__/allowed-keywords.test.ts
```

Run tests matching a name pattern:
```bash
pnpm test -- --testNamePattern="PostgreSQL"
```

Verbose output for debugging:
```bash
pnpm test:integration --reporter=verbose
```

## Test Architecture

Vitest is configured with two projects in `vitest.config.ts`:
- **unit**: All `*.test.ts` files excluding `*integration*` in the filename
- **integration**: Only `*integration*.test.ts` files

This means the naming convention matters — integration tests MUST have `integration` in their filename to be correctly categorized.

### Test File Locations

**Unit tests** (`*.test.ts` without `integration` in the name; no Docker needed):
- `src/utils/__tests__/` — Utility function tests (SQL parsing and classification, access policy, row limiting, DSN obfuscation, SafeURL, SQLite DSNs, SSH config and tunnel, identifier quoting, parameter mapping, result columns, query timeouts, config watcher, auth token, cross-origin, AWS RDS signer, …)
- `src/tools/__tests__/` — Tool handler tests (execute-sql, search-objects, explain-sql, health-check, custom-tool-handler, registry, builtin-tools)
- `src/config/__tests__/` — Configuration tests (env parsing, TOML loading)
- `src/connectors/__tests__/` — Connector unit tests (dsn-parser, manager, oracle, clickhouse (against a fake HTTP server), per-connector timeout / auth / pool behaviour, read-only transaction strategy)
- `src/requests/__tests__/` — Request store tests
- `src/__tests__/` — Connector loading and `plugin-consistency.test.ts` (plugin / bundle / registry manifests stay in step with `package.json`)

**Integration tests** (`integration` in the file name). List them with `git ls-files 'src/**/*integration*.test.ts'`.

Need Docker (Testcontainers):
- `src/connectors/__tests__/postgres.integration.test.ts`
- `src/connectors/__tests__/postgres-ssh.integration.test.ts`
- `src/connectors/__tests__/postgres-client-cert.integration.test.ts`
- `src/connectors/__tests__/mysql.integration.test.ts`
- `src/connectors/__tests__/mariadb.integration.test.ts`
- `src/connectors/__tests__/sqlserver.integration.test.ts`
- `src/connectors/__tests__/oracle.integration.test.ts`
- `src/connectors/__tests__/clickhouse.integration.test.ts`

Run without Docker (in-memory SQLite or no database):
- `src/connectors/__tests__/sqlite.integration.test.ts`
- `src/connectors/__tests__/multi-sqlite-sources.integration.test.ts`
- `src/__tests__/json-rpc-integration.test.ts`
- `src/__tests__/http-bind-host.integration.test.ts`
- `src/api/__tests__/sources.integration.test.ts`
- `src/api/__tests__/requests.integration.test.ts`
- `src/config/__tests__/ssh-config-integration.test.ts`
- `src/utils/__tests__/tool-metadata.integration.test.ts`
- `src/tools/__tests__/builtin-tool-table.integration.test.ts`

### IntegrationTestBase

Database connector integration tests extend `IntegrationTestBase<TContainer>` from `src/connectors/__tests__/shared/integration-test-base.ts`. This abstract class provides:

- **Lifecycle**: `registerLifecycle()` registers the `beforeAll` (container start, 120s timeout → connect → setup test data) and `afterAll` (cleanup) hooks
- **Shared test suites**: `createCommonTests()` runs all of `createConnectionTests()`, `createSchemaTests()`, `createTableTests()`, `createSQLExecutionTests()`, `createStoredProcedureTests()`, `createCommentTests()`, `createErrorHandlingTests()`, `createMaxRowsTests()` and `createReadonlyBackstopTests()`; `createSSLTests()` is opt-in for engines whose container can report session encryption (`expectSessionEncryption` hook)
- **Dialect hooks**: `DatabaseTestConfig` flags gate the tests an engine cannot run; `userLimitedSQL(n)` is overridden where the row limit is not `LIMIT` (SQL Server `TOP`, Oracle `FETCH FIRST`)
- **`withConnector(config, fn)`**: connects a second connector with the given `ConnectorConfig`, runs `fn`, and always disconnects — use it instead of a hand-written connect / try / finally
- **Standard test data**: `users` table (id, name, email, age) + `orders` table (id, user_id, amount) + `test_schema.products`

To add a new database connector test, extend this class and implement:
- `createContainer()` — Start the Testcontainers instance
- `createConnector()` — Create the database connector
- `setupTestData(connector)` — Populate test tables

MySQL and MariaDB share almost everything: both extend `MySQLFamilyIntegrationTest` (`shared/mysql-family-suite.ts`) and call `createFamilyTests(traits)`. A test that applies to both engines goes there; each engine's own file holds only what differs.

Behaviour that belongs to the database engine rather than to a connector branch (window functions, JSON operators, storage engines…) is not tested here — a new integration test should name the connector code it exercises.

### Shared helpers for other tests

- `src/tools/__tests__/helpers.ts` — `createMockConnector()`, `parseToolResponse()`, `describeRequestTracking()` for tool handler tests. Error-envelope shaping lives in `runToolRequest` and is tested once, in `execute-sql.test.ts`.
- `src/api/__tests__/test-server.ts` — `startApiServer(routes)` serves API handlers on an ephemeral port.
- `src/__tests__/spawn-http-server.ts` — `spawnHttpServer(bindHost?)` starts the real server as a child process in an isolated working directory.

### Test Fixtures

Located in `src/__fixtures__/`:
- `helpers.ts` — Utilities: `fixtureTomlPath()`, `loadFixtureConfig()`, `setupManagerWithFixture()`
- `toml/multi-sqlite.toml` — Three in-memory SQLite databases (database_a, database_b, database_c)
- `toml/readonly-maxrows.toml` — Sources with readonly/max_rows tool configurations
- `toml/tunneled-credentials.toml` — A lazy (never connected) PostgreSQL source with a database password and SSH tunnel credentials, for asserting what the sources API exposes and withholds

Usage:
```typescript
import { setupManagerWithFixture, FIXTURES } from '../../__fixtures__/helpers.js';
const manager = await setupManagerWithFixture(FIXTURES.MULTI_SQLITE);
// ... test ...
await manager.disconnect();
```

### Mocking Patterns

Unit tests use vitest mocking:
```typescript
vi.mock('../../connectors/manager.js');  // Mock ConnectorManager
vi.mocked(ConnectorManager.getCurrentConnector).mockReturnValue(mockConnector);
```

SSH tunnel tests mock `SSHTunnel.prototype.establish` to avoid real SSH connections while testing config passing.

## Integration Testing

Integration tests use [Testcontainers](https://testcontainers.com/) to run real database instances in Docker.

### Prerequisites

Before running integration tests:
1. Docker is installed and running: `docker ps`
2. Sufficient Docker memory (4GB+ recommended, especially for SQL Server)
3. Network access to pull Docker images

### Database Images

| Database | Image | Notes |
|----------|-------|-------|
| PostgreSQL | `postgres:15-alpine` | Fast startup |
| MySQL | `@testcontainers/mysql` (`mysql:8.0`) | Supports IAM auth testing |
| MariaDB | `@testcontainers/mariadb` (`mariadb:10.11`) | Supports IAM auth testing |
| SQL Server | `@testcontainers/mssqlserver` (`mssql/server:2019-latest`) | Slow startup (3-5 min), needs 4GB+ RAM |
| Oracle | `@testcontainers/oraclefree` (`gvenzl/oracle-free:23-slim-faststart`) | ~1.2GB pull, 1-2 min startup, needs 2GB+ RAM |
| ClickHouse | `@testcontainers/clickhouse` (`clickhouse/clickhouse-server:25.8`) | Fast startup; replaces the shared SQL-execution suite with its own (no auto-increment, no repeated aliases) |
| SQLite | No container needed | In-memory or file-based |

## Troubleshooting

### Container Startup Failures
```bash
docker ps                    # Verify Docker is running
docker system df             # Check disk space
docker pull postgres:15-alpine  # Manually pull images
```

### SQL Server Timeouts
SQL Server containers are the slowest to start (3-5 minutes). Run them separately and ensure Docker has 4GB+ memory:
```bash
pnpm test src/connectors/__tests__/sqlserver.integration.test.ts
```

### Test Isolation Issues
Each integration test manages its own container lifecycle. If containers leak, clean up:
```bash
docker ps -a | grep testcontainers  # Find leaked containers
docker container prune               # Clean up stopped containers
```

### "Hook timed out in 10000ms" in `afterAll`
All tests pass but the suite is marked failed at its `afterAll` (seen on MariaDB and
postgres-ssh in CI). Teardown is `container.stop()`, which runs `docker stop -t 0`
followed by `docker rm -v` (removing the data volume). On a shared Docker daemon that
is simultaneously pulling/extracting the Oracle or SQL Server image, that removal can
exceed Vitest's 10s default hook timeout. The integration project sets
`hookTimeout: 60_000` in `vitest.config.ts` for this reason — do not pass a shorter
timeout to `afterAll`, and if you add a suite with its own teardown, let it use the
project default rather than the Vitest default.

### CI Failures
The CI workflow (`.github/workflows/run-tests.yml`) runs unit and integration tests as separate parallel jobs on PR events. Unit tests don't need Docker; integration tests verify Docker availability first. Check the specific job that failed.

## Adding New Tests

**Unit test**: Create `src/{module}/__tests__/{name}.test.ts` — will auto-run with `pnpm test:unit`.

**Integration test**: Create `src/{module}/__tests__/{name}.integration.test.ts` — the `integration` in the filename is what routes it to `pnpm test:integration`.

**New connector test**: Extend `IntegrationTestBase`, implement the three abstract methods, then call `registerLifecycle()` and `createCommonTests()` inside the `describe`.

**Prefer a row to a test**: most of the suite is `it.each` tables. When a new case differs from an existing one only in its input and expected value, add a row to that table rather than a new `it`.
