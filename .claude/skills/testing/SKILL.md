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

**Unit tests** (~20 files, no Docker needed):
- `src/utils/__tests__/` — Utility function tests (SQL parsing, DSN obfuscation, SSH config, allowed keywords, identifier quoting, parameter mapping, row limiting, safe URL, config watcher, AWS RDS signer)
- `src/tools/__tests__/` — Tool handler tests (execute-sql, search-objects, custom-tool-handler)
- `src/config/__tests__/` — Configuration tests (env parsing, TOML loading)
- `src/connectors/__tests__/` — Connector unit tests (dsn-parser, manager)
- `src/requests/__tests__/` — Request store tests

**Integration tests** (~11 files, Docker required):
- `src/connectors/__tests__/postgres.integration.test.ts`
- `src/connectors/__tests__/mysql.integration.test.ts`
- `src/connectors/__tests__/mariadb.integration.test.ts`
- `src/connectors/__tests__/sqlserver.integration.test.ts`
- `src/connectors/__tests__/sqlite.integration.test.ts`
- `src/connectors/__tests__/postgres-ssh.integration.test.ts`
- `src/connectors/__tests__/multi-sqlite-sources.integration.test.ts`
- `src/__tests__/json-rpc-integration.test.ts`
- `src/api/__tests__/sources.integration.test.ts`
- `src/api/__tests__/requests.integration.test.ts`
- `src/config/__tests__/ssh-config-integration.test.ts`

### IntegrationTestBase

Database connector integration tests extend `IntegrationTestBase<TContainer>` from `src/connectors/__tests__/shared/integration-test-base.ts`. This abstract class provides:

- **Lifecycle**: Container start in `beforeAll` (120s timeout) → connect → setup test data → run tests → cleanup in `afterAll`
- **Shared test suites**: `createConnectionTests()`, `createSchemaTests()`, `createTableTests()`, `createSQLExecutionTests()`, `createStoredProcedureTests()`, `createCommentTests()`, `createErrorHandlingTests()`
- **Standard test data**: `users` table (id, name, email, age) + `orders` table (id, user_id, amount) + `test_schema.products`

To add a new database connector test, extend this class and implement:
- `createContainer()` — Start the Testcontainers instance
- `createConnector()` — Create the database connector
- `setupTestData(connector)` — Populate test tables

### Test Fixtures

Located in `src/__fixtures__/`:
- `helpers.ts` — Utilities: `fixtureTomlPath()`, `loadFixtureConfig()`, `setupManagerWithFixture()`
- `toml/multi-sqlite.toml` — Three in-memory SQLite databases (database_a, database_b, database_c)
- `toml/readonly-maxrows.toml` — Sources with readonly/max_rows tool configurations

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
| MySQL | `@testcontainers/mysql` | Supports IAM auth testing |
| MariaDB | `@testcontainers/mariadb` | Supports IAM auth testing |
| SQL Server | `@testcontainers/mssqlserver` | Slow startup (3-5 min), needs 4GB+ RAM |
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

### CI Failures
The CI workflow (`.github/workflows/run-tests.yml`) runs unit and integration tests as separate parallel jobs on PR events. Unit tests don't need Docker; integration tests verify Docker availability first. Check the specific job that failed.

## Adding New Tests

**Unit test**: Create `src/{module}/__tests__/{name}.test.ts` — will auto-run with `pnpm test:unit`.

**Integration test**: Create `src/{module}/__tests__/{name}.integration.test.ts` — the `integration` in the filename is what routes it to `pnpm test:integration`.

**New connector test**: Extend `IntegrationTestBase`, implement the three abstract methods, and call the shared test suite methods.
