# Query Timeout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement `query_timeout` configuration across PostgreSQL, MySQL, MariaDB, and SQL Server connectors.

**Architecture:** Rename `request_timeout`/`requestTimeoutSeconds` to `query_timeout`/`queryTimeoutSeconds`. Apply timeout at connection/query level using each database driver's native mechanism. SQLite is skipped (silently ignored).

**Tech Stack:** TypeScript, node-postgres (pg), mysql2, mariadb, mssql

---

## Task 1: Update ConnectorConfig Interface

**Files:**
- Modify: `src/connectors/interface.ts:57-70`

**Step 1: Update the interface**

Change `requestTimeoutSeconds` to `queryTimeoutSeconds` and update the comment:

```typescript
export interface ConnectorConfig {
  /** Connection timeout in seconds (PostgreSQL, MySQL, MariaDB, SQL Server) */
  connectionTimeoutSeconds?: number;
  /** Query timeout in seconds (PostgreSQL, MySQL, MariaDB, SQL Server) */
  queryTimeoutSeconds?: number;
  /**
   * Read-only mode for SDK-level enforcement (PostgreSQL, SQLite)
   * - PostgreSQL: Sets default_transaction_read_only at connection level
   * - SQLite: Opens database in readonly mode (not supported for :memory: databases)
   * Note: Application-level validation is done via ExecuteOptions.readonly
   */
  readonly?: boolean;
  // Future database-specific options can be added here as optional fields
}
```

**Step 2: Run build to verify no type errors**

Run: `pnpm run build`
Expected: Build succeeds (will fail later when we update connectors)

**Step 3: Commit**

```bash
git add src/connectors/interface.ts
git commit -m "refactor: rename requestTimeoutSeconds to queryTimeoutSeconds in ConnectorConfig"
```

---

## Task 2: Update SourceConfig Type

**Files:**
- Modify: `src/types/config.ts:33-39`

**Step 1: Update the interface**

Change `request_timeout` to `query_timeout` and update the comment:

```typescript
export interface SourceConfig extends ConnectionParams, SSHConfig {
  id: string;
  dsn?: string;
  connection_timeout?: number; // Connection timeout in seconds
  query_timeout?: number; // Query timeout in seconds (PostgreSQL, MySQL, MariaDB, SQL Server)
  init_script?: string; // Optional SQL script to run on connection (for demo mode or initialization)
}
```

**Step 2: Commit**

```bash
git add src/types/config.ts
git commit -m "refactor: rename request_timeout to query_timeout in SourceConfig"
```

---

## Task 3: Update TOML Loader Validation

**Files:**
- Modify: `src/config/toml-loader.ts:259-267`

**Step 1: Update validation field name**

Change `request_timeout` to `query_timeout`:

```typescript
  // Validate query_timeout if provided
  if (source.query_timeout !== undefined) {
    if (typeof source.query_timeout !== "number" || source.query_timeout <= 0) {
      throw new Error(
        `Configuration file ${configPath}: source '${source.id}' has invalid query_timeout. ` +
          `Must be a positive number (in seconds).`
      );
    }
  }
```

**Step 2: Commit**

```bash
git add src/config/toml-loader.ts
git commit -m "refactor: rename request_timeout to query_timeout in TOML validation"
```

---

## Task 4: Update ConnectorManager

**Files:**
- Modify: `src/connectors/manager.ts:118-130`

**Step 1: Update config building logic**

Remove the SQL Server-only check and apply to all connectors except SQLite:

```typescript
    // Build config for database-specific options
    const config: ConnectorConfig = {};
    if (source.connection_timeout !== undefined) {
      config.connectionTimeoutSeconds = source.connection_timeout;
    }
    // Query timeout is supported by PostgreSQL, MySQL, MariaDB, SQL Server (not SQLite)
    if (source.query_timeout !== undefined && connector.id !== 'sqlite') {
      config.queryTimeoutSeconds = source.query_timeout;
    }
    // Pass readonly flag for SDK-level enforcement (PostgreSQL, SQLite)
    if (source.readonly !== undefined) {
      config.readonly = source.readonly;
    }
```

**Step 2: Commit**

```bash
git add src/connectors/manager.ts
git commit -m "feat: apply query_timeout to all connectors except SQLite"
```

---

## Task 5: Update PostgreSQL Connector

**Files:**
- Modify: `src/connectors/postgres/index.ts:28-72`

**Step 1: Add queryTimeoutSeconds to parse method**

Update the `parse` method to accept and apply query timeout:

```typescript
class PostgresDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<pg.PoolConfig> {
    const connectionTimeoutSeconds = config?.connectionTimeoutSeconds;
    const queryTimeoutSeconds = config?.queryTimeoutSeconds;
    // ... existing validation code ...

    try {
      // ... existing URL parsing code ...

      // Apply connection timeout if specified
      if (connectionTimeoutSeconds !== undefined) {
        // pg library expects timeout in milliseconds
        config.connectionTimeoutMillis = connectionTimeoutSeconds * 1000;
      }

      // Apply query timeout if specified (client-side timeout)
      if (queryTimeoutSeconds !== undefined) {
        // pg library expects query_timeout in milliseconds
        poolConfig.query_timeout = queryTimeoutSeconds * 1000;
      }

      return poolConfig;
    } catch (error) {
      // ... existing error handling ...
    }
  }
```

Note: The variable name `config` on line 44 shadows the parameter. We need to rename the inner `config` to `poolConfig`:

```typescript
  async parse(dsn: string, config?: ConnectorConfig): Promise<pg.PoolConfig> {
    const connectionTimeoutSeconds = config?.connectionTimeoutSeconds;
    const queryTimeoutSeconds = config?.queryTimeoutSeconds;
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid PostgreSQL DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      // Use the SafeURL helper instead of the built-in URL
      // This will handle special characters in passwords, etc.
      const url = new SafeURL(dsn);

      const poolConfig: pg.PoolConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 5432,
        database: url.pathname ? url.pathname.substring(1) : '', // Remove leading '/' if exists
        user: url.username,
        password: url.password,
      };

      // Handle query parameters (like sslmode, etc.)
      url.forEachSearchParam((value, key) => {
        if (key === "sslmode") {
          if (value === "disable") {
            poolConfig.ssl = false;
          } else if (value === "require") {
            poolConfig.ssl = { rejectUnauthorized: false };
          } else {
            poolConfig.ssl = true;
          }
        }
        // Add other parameters as needed
      });

      // Apply connection timeout if specified
      if (connectionTimeoutSeconds !== undefined) {
        // pg library expects timeout in milliseconds
        poolConfig.connectionTimeoutMillis = connectionTimeoutSeconds * 1000;
      }

      // Apply query timeout if specified (client-side timeout)
      if (queryTimeoutSeconds !== undefined) {
        // pg library expects query_timeout in milliseconds
        poolConfig.query_timeout = queryTimeoutSeconds * 1000;
      }

      return poolConfig;
    } catch (error) {
      throw new Error(
        `Failed to parse PostgreSQL DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
```

**Step 2: Run build to verify**

Run: `pnpm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/connectors/postgres/index.ts
git commit -m "feat(postgres): add query_timeout support"
```

---

## Task 6: Update MySQL Connector

**Files:**
- Modify: `src/connectors/mysql/index.ts`

MySQL2's timeout option needs to be applied per-query, not at connection level. We need to store the timeout and apply it in executeSQL.

**Step 1: Add queryTimeoutMs property to MySQLConnector class**

After line 116 (after `private sourceId: string = "default";`):

```typescript
  private queryTimeoutMs?: number;
```

**Step 2: Update connect method to store timeout**

After line 130 (`const connectionOptions = await this.dsnParser.parse(dsn, config);`), add:

```typescript
    // Store query timeout for per-query application
    if (config?.queryTimeoutSeconds !== undefined) {
      this.queryTimeoutMs = config.queryTimeoutSeconds * 1000;
    }
```

**Step 3: Update executeSQL to apply timeout**

In the executeSQL method, update the query calls to include timeout. Change line 533 and 541:

For the parameterized query (around line 533):
```typescript
        try {
          results = await conn.query({ sql: processedSQL, timeout: this.queryTimeoutMs }, parameters);
        } catch (error) {
```

For the non-parameterized query (around line 541):
```typescript
        results = await conn.query({ sql: processedSQL, timeout: this.queryTimeoutMs });
```

**Step 4: Run build to verify**

Run: `pnpm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/connectors/mysql/index.ts
git commit -m "feat(mysql): add query_timeout support"
```

---

## Task 7: Update MariaDB Connector

**Files:**
- Modify: `src/connectors/mariadb/index.ts:28-54`

**Step 1: Update parse method to include queryTimeout**

Add `queryTimeoutSeconds` extraction and apply it to pool config:

```typescript
class MariadbDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<mariadb.ConnectionConfig> {
    const connectionTimeoutSeconds = config?.connectionTimeoutSeconds;
    const queryTimeoutSeconds = config?.queryTimeoutSeconds;
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid MariaDB DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      // Use the SafeURL helper instead of the built-in URL
      // This will handle special characters in passwords, etc.
      const url = new SafeURL(dsn);

      const connectionConfig: mariadb.ConnectionConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 3306,
        database: url.pathname ? url.pathname.substring(1) : '', // Remove leading '/' if exists
        user: url.username,
        password: url.password,
        multipleStatements: true, // Enable native multi-statement support
        ...(connectionTimeoutSeconds !== undefined && {
          connectTimeout: connectionTimeoutSeconds * 1000
        }),
        ...(queryTimeoutSeconds !== undefined && {
          queryTimeout: queryTimeoutSeconds * 1000
        }),
      };
```

Note: The inner variable is named `config` which shadows the parameter. We need to rename it to `connectionConfig`.

**Step 2: Update remaining references from `config` to `connectionConfig`**

All subsequent references to `config` in the parse method should use `connectionConfig`:
- Line 57-67 (SSL handling): `connectionConfig.ssl = ...`
- Line 74-78 (AWS IAM): `connectionConfig.ssl = ...`
- Line 81: `return connectionConfig;`

**Step 3: Run build to verify**

Run: `pnpm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/connectors/mariadb/index.ts
git commit -m "feat(mariadb): add query_timeout support"
```

---

## Task 8: Update SQL Server Connector

**Files:**
- Modify: `src/connectors/sqlserver/index.ts:24-26, 79-81`

**Step 1: Update variable name from requestTimeoutSeconds to queryTimeoutSeconds**

Change line 26:
```typescript
    const queryTimeoutSeconds = config?.queryTimeoutSeconds;
```

Change lines 79-81:
```typescript
          ...(queryTimeoutSeconds !== undefined && {
            requestTimeout: queryTimeoutSeconds * 1000
          }),
```

**Step 2: Run build to verify**

Run: `pnpm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/connectors/sqlserver/index.ts
git commit -m "refactor(sqlserver): rename requestTimeoutSeconds to queryTimeoutSeconds"
```

---

## Task 9: Update TOML Example File

**Files:**
- Modify: `dbhub.toml.example:76`

**Step 1: Update the example comment**

Change line 76 from:
```toml
# request_timeout = 60  # SQL Server-specific: query timeout in seconds
```

To:
```toml
# query_timeout = 60  # Query timeout in seconds (works for all databases except SQLite)
```

**Step 2: Commit**

```bash
git add dbhub.toml.example
git commit -m "docs: update query_timeout in TOML example"
```

---

## Task 10: Update TOML Loader Tests

**Files:**
- Modify: `src/config/__tests__/toml-loader.test.ts:404-460`

**Step 1: Rename test describe block and update field names**

Change `describe('request_timeout validation'` to `describe('query_timeout validation'`:

```typescript
    describe('query_timeout validation', () => {
      it('should accept valid query_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
query_timeout = 120
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].query_timeout).toBe(120);
      });

      it('should throw error for negative query_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
query_timeout = -60
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow('invalid query_timeout');
      });

      it('should throw error for zero query_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
query_timeout = 0
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        expect(() => loadTomlConfig()).toThrow('invalid query_timeout');
      });

      it('should accept both connection_timeout and query_timeout', () => {
        const tomlContent = `
[[sources]]
id = "test_db"
dsn = "postgres://user:pass@localhost:5432/testdb"
connection_timeout = 30
query_timeout = 120
`;
        fs.writeFileSync(path.join(tempDir, 'dbhub.toml'), tomlContent);

        const result = loadTomlConfig();

        expect(result).toBeTruthy();
        expect(result?.sources[0].connection_timeout).toBe(30);
        expect(result?.sources[0].query_timeout).toBe(120);
      });
    });
```

Note: Changed DSN from `sqlserver://` to `postgres://` since query_timeout now works for all databases.

**Step 2: Run tests to verify**

Run: `pnpm test src/config/__tests__/toml-loader.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/config/__tests__/toml-loader.test.ts
git commit -m "test: update tests for query_timeout rename"
```

---

## Task 11: Add PostgreSQL Integration Test

**Files:**
- Modify: `src/connectors/__tests__/postgres.integration.test.ts`

**Step 1: Add query timeout test case**

Add this test after the existing connection tests:

```typescript
  describe('query timeout', () => {
    it('should timeout long-running queries', async () => {
      const connector = new PostgresConnector();
      await connector.connect(testDSN, undefined, { queryTimeoutSeconds: 1 });

      try {
        // pg_sleep(5) should exceed the 1 second timeout
        await expect(
          connector.executeSQL('SELECT pg_sleep(5)', {})
        ).rejects.toThrow(/timeout/i);
      } finally {
        await connector.disconnect();
      }
    });
  });
```

**Step 2: Run integration test**

Run: `pnpm test:integration src/connectors/__tests__/postgres.integration.test.ts`
Expected: Test passes (query times out as expected)

**Step 3: Commit**

```bash
git add src/connectors/__tests__/postgres.integration.test.ts
git commit -m "test(postgres): add query_timeout integration test"
```

---

## Task 12: Add MySQL Integration Test

**Files:**
- Modify: `src/connectors/__tests__/mysql.integration.test.ts`

**Step 1: Add query timeout test case**

Add this test after the existing connection tests:

```typescript
  describe('query timeout', () => {
    it('should timeout long-running queries', async () => {
      const connector = new MySQLConnector();
      await connector.connect(testDSN, undefined, { queryTimeoutSeconds: 1 });

      try {
        // SLEEP(5) should exceed the 1 second timeout
        await expect(
          connector.executeSQL('SELECT SLEEP(5)', {})
        ).rejects.toThrow(/timeout/i);
      } finally {
        await connector.disconnect();
      }
    });
  });
```

**Step 2: Run integration test**

Run: `pnpm test:integration src/connectors/__tests__/mysql.integration.test.ts`
Expected: Test passes (query times out as expected)

**Step 3: Commit**

```bash
git add src/connectors/__tests__/mysql.integration.test.ts
git commit -m "test(mysql): add query_timeout integration test"
```

---

## Task 13: Add MariaDB Integration Test

**Files:**
- Modify: `src/connectors/__tests__/mariadb.integration.test.ts`

**Step 1: Add query timeout test case**

Add this test after the existing connection tests:

```typescript
  describe('query timeout', () => {
    it('should timeout long-running queries', async () => {
      const connector = new MariaDBConnector();
      await connector.connect(testDSN, undefined, { queryTimeoutSeconds: 1 });

      try {
        // SLEEP(5) should exceed the 1 second timeout
        await expect(
          connector.executeSQL('SELECT SLEEP(5)', {})
        ).rejects.toThrow(/timeout/i);
      } finally {
        await connector.disconnect();
      }
    });
  });
```

**Step 2: Run integration test**

Run: `pnpm test:integration src/connectors/__tests__/mariadb.integration.test.ts`
Expected: Test passes (query times out as expected)

**Step 3: Commit**

```bash
git add src/connectors/__tests__/mariadb.integration.test.ts
git commit -m "test(mariadb): add query_timeout integration test"
```

---

## Task 14: Add SQL Server Integration Test

**Files:**
- Modify: `src/connectors/__tests__/sqlserver.integration.test.ts`

**Step 1: Add query timeout test case**

Add this test after the existing connection tests:

```typescript
  describe('query timeout', () => {
    it('should timeout long-running queries', async () => {
      const connector = new SQLServerConnector();
      await connector.connect(testDSN, undefined, { queryTimeoutSeconds: 1 });

      try {
        // WAITFOR DELAY should exceed the 1 second timeout
        await expect(
          connector.executeSQL("WAITFOR DELAY '00:00:05'", {})
        ).rejects.toThrow(/timeout/i);
      } finally {
        await connector.disconnect();
      }
    });
  });
```

**Step 2: Run integration test**

Run: `pnpm test:integration src/connectors/__tests__/sqlserver.integration.test.ts`
Expected: Test passes (query times out as expected)

**Step 3: Commit**

```bash
git add src/connectors/__tests__/sqlserver.integration.test.ts
git commit -m "test(sqlserver): add query_timeout integration test"
```

---

## Task 15: Final Build and Test

**Step 1: Run full build**

Run: `pnpm run build`
Expected: Build succeeds with no errors

**Step 2: Run all unit tests**

Run: `pnpm test`
Expected: All tests pass

**Step 3: Run all integration tests (optional, requires Docker)**

Run: `pnpm test:integration`
Expected: All tests pass

**Step 4: Final commit (if any uncommitted changes)**

```bash
git status
# If there are changes:
git add .
git commit -m "chore: final cleanup for query_timeout feature"
```

---

## Breaking Change Notice

**TOML field renamed:** `request_timeout` → `query_timeout`

Users with existing `request_timeout` in their TOML configuration files must update to `query_timeout`.
