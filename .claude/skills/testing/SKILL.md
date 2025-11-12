---
name: testing
description: Run and troubleshoot tests for DBHub, including unit tests, integration tests with Testcontainers, and database-specific tests. Use when asked to run tests, fix test failures, debug integration tests, or troubleshoot Docker/database container issues.
---

# Testing Skill

This skill helps you run and troubleshoot tests in the DBHub project.

## Quick Commands

Before running tests, consult [TESTING.md](../../../TESTING.md) for comprehensive documentation.

Common test commands:
- `pnpm test` - Run all tests
- `pnpm test:watch` - Run tests in watch mode
- `pnpm test:integration` - Run integration tests (requires Docker)
- `pnpm test src/connectors/__tests__/{db-type}.integration.test.ts` - Test specific database connector

## Integration Testing

Integration tests use [Testcontainers](https://testcontainers.com/) to run real database instances in Docker.

### Prerequisites Checklist

Before running integration tests, verify:
1. Docker is installed and running: `docker ps`
2. Sufficient Docker memory allocated (4GB+ recommended)
3. Network access to pull Docker images

### Database-Specific Tests

Test individual database connectors:
```bash
# PostgreSQL
pnpm test src/connectors/__tests__/postgres.integration.test.ts

# MySQL
pnpm test src/connectors/__tests__/mysql.integration.test.ts

# MariaDB
pnpm test src/connectors/__tests__/mariadb.integration.test.ts

# SQL Server
pnpm test src/connectors/__tests__/sqlserver.integration.test.ts

# SQLite
pnpm test src/connectors/__tests__/sqlite.integration.test.ts

# JSON RPC integration
pnpm test src/__tests__/json-rpc-integration.test.ts
```

## Troubleshooting

### Container Startup Issues

If containers fail to start:
```bash
# Verify Docker is running
docker ps

# Check disk space
docker system df

# Manually pull images
docker pull postgres:15-alpine
docker pull mysql:8.0
docker pull mariadb:10.11
docker pull mcr.microsoft.com/mssql/server:2019-latest
```

### SQL Server Timeout Issues

SQL Server containers require 3-5 minutes to start:
- Ensure Docker has 4GB+ memory allocated
- Run SQL Server tests separately: `pnpm test src/connectors/__tests__/sqlserver.integration.test.ts`
- Check timeout settings in test files

### Debug Failed Tests

```bash
# Run with verbose output
pnpm test:integration --reporter=verbose

# Run specific test pattern
pnpm test:integration -- --testNamePattern="PostgreSQL"

# Check container logs
docker logs <container_id>
```

## Test Architecture

All integration tests follow this pattern:
1. **Container Lifecycle**: Start database container → Connect → Setup test data → Run tests → Cleanup
2. **Shared Test Utilities**: Common patterns in `IntegrationTestBase` class
3. **Database-Specific Features**: Each database tests unique capabilities
4. **Error Handling**: Comprehensive testing of connection errors, invalid SQL, edge cases

## When to Use This Skill

Use this skill when:
- Asked to run tests or verify code changes
- Debugging test failures
- Setting up integration tests for new features
- Troubleshooting Docker or Testcontainers issues
- Adding new database connector tests
- Investigating CI/CD test failures

## Related Files

- [TESTING.md](../../../TESTING.md) - Comprehensive testing documentation
- `src/connectors/__tests__/` - Integration test files
- `vitest.config.ts` - Vitest configuration
- `.github/workflows/` - CI/CD test workflows
