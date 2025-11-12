# SQL Server Named Instances Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable DBHub to connect to SQL Server named instances using the instance name in DSN connection strings.

**Architecture:** Extend the SQL Server DSN parser to extract `instanceName` from query parameters and pass it to the mssql library's `options.instanceName` configuration. The mssql library will handle named instance resolution via SQL Server Browser service (UDP port 1434).

**Tech Stack:** TypeScript, mssql npm library (tedious driver), vitest for testing

---

## Background

SQL Server supports multiple instances on a single host using named instances. Users access these via formats like:
- SSMS: `127.0.0.1\ENV1,1433` (host\instance,port)
- JDBC: `jdbc:sqlserver://127.0.0.1:1433;instanceName=ENV1`

The mssql library supports this via `config.options.instanceName` property. DBHub needs to expose this through the DSN format.

**Proposed DSN format:**
```
sqlserver://user:password@host:port/database?instanceName=ENV1
```

---

## Task 1: Add instanceName Query Parameter Support to DSN Parser

**Files:**
- Modify: `src/connectors/sqlserver/index.ts:22-121` (SQLServerDSNParser class)

### Step 1: Write failing test for instanceName parsing

**File:** `src/connectors/__tests__/sqlserver.integration.test.ts`

Add test after line 181 (in SSL/TLS Configuration describe block or create new describe block):

```typescript
  describe('Named Instance Configuration', () => {
    it('should parse instanceName from query parameter', async () => {
      const parser = new SQLServerConnector().dsnParser;
      const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb?instanceName=ENV1');

      expect(config.options?.instanceName).toBe('ENV1');
      expect(config.server).toBe('localhost');
      expect(config.port).toBe(1433);
      expect(config.database).toBe('testdb');
    });

    it('should parse instanceName with other query parameters', async () => {
      const parser = new SQLServerConnector().dsnParser;
      const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb?instanceName=ENV2&sslmode=disable');

      expect(config.options?.instanceName).toBe('ENV2');
      expect(config.options?.encrypt).toBe(false);
    });

    it('should work without instanceName (backward compatibility)', async () => {
      const parser = new SQLServerConnector().dsnParser;
      const config = await parser.parse('sqlserver://user:pass@localhost:1433/testdb');

      expect(config.options?.instanceName).toBeUndefined();
      expect(config.server).toBe('localhost');
      expect(config.port).toBe(1433);
    });
  });
```

### Step 2: Run test to verify it fails

```bash
pnpm test src/connectors/__tests__/sqlserver.integration.test.ts -t "Named Instance"
```

**Expected output:** FAIL - `expect(config.options?.instanceName).toBe('ENV1')` fails because instanceName is not parsed yet.

### Step 3: Implement instanceName parsing in SQLServerDSNParser

**File:** `src/connectors/sqlserver/index.ts`

Modify the `parse` method at lines 38-51 to include instanceName parsing. Add this code after line 50 (after the authentication check):

```typescript
      // Process query parameters
      url.forEachSearchParam((value, key) => {
        if (key === "connectTimeout") {
          options.connectTimeout = parseInt(value, 10);
        } else if (key === "requestTimeout") {
          options.requestTimeout = parseInt(value, 10);
        } else if (key === "authentication") {
          options.authentication = value;
        } else if (key === "sslmode") {
          options.sslmode = value;
        } else if (key === "instanceName") {
          options.instanceName = value;
        }
      });
```

Then modify the config options assignment at lines 72-78 to include instanceName:

```typescript
      const config: sql.config = {
        user: url.username,
        password: url.password,
        server: url.hostname,
        port: url.port ? parseInt(url.port) : 1433, // Default SQL Server port
        database: url.pathname ? url.pathname.substring(1) : '', // Remove leading slash
        options: {
          encrypt: options.encrypt ?? false, // Default to unencrypted for development
          trustServerCertificate: options.trustServerCertificate ?? false,
          connectTimeout: options.connectTimeout ?? 15000,
          requestTimeout: options.requestTimeout ?? 15000,
          instanceName: options.instanceName, // Add named instance support
        },
      };
```

### Step 4: Run test to verify it passes

```bash
pnpm test src/connectors/__tests__/sqlserver.integration.test.ts -t "Named Instance"
```

**Expected output:** PASS - All three tests pass

### Step 5: Commit

```bash
git add src/connectors/sqlserver/index.ts src/connectors/__tests__/sqlserver.integration.test.ts
git commit -m "feat(sqlserver): add named instance support via instanceName query parameter"
```

---

## Task 2: Update TOML Configuration Support for instanceName

**Files:**
- Modify: `src/types/config.ts:1-100` (DatabaseSource interface)
- Modify: `src/config/toml-loader.ts:1-300` (buildDSNFromSource function)

### Step 1: Write failing test for TOML instanceName

**File:** `src/config/__tests__/toml-loader.test.ts`

Add test after line 309 (after the SQL Server DSN test):

```typescript
    it('should build SQL Server DSN with instanceName', () => {
      const source: DatabaseSource = {
        id: 'sqlserver_instance',
        type: 'sqlserver',
        host: 'localhost',
        port: 1433,
        database: 'testdb',
        user: 'sa',
        password: 'Pass123!',
        instanceName: 'ENV1'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('sqlserver://sa:Pass123!@localhost:1433/testdb?instanceName=ENV1');
    });

    it('should build SQL Server DSN without instanceName (backward compat)', () => {
      const source: DatabaseSource = {
        id: 'sqlserver_standard',
        type: 'sqlserver',
        host: 'localhost',
        port: 1433,
        database: 'testdb',
        user: 'sa',
        password: 'Pass123!'
      };

      const dsn = buildDSNFromSource(source);

      expect(dsn).toBe('sqlserver://sa:Pass123!@localhost:1433/testdb');
    });
```

### Step 2: Run test to verify it fails

```bash
pnpm test src/config/__tests__/toml-loader.test.ts -t "instanceName"
```

**Expected output:** FAIL - TypeScript error for `instanceName` property not existing on DatabaseSource

### Step 3: Add instanceName to DatabaseSource interface

**File:** `src/types/config.ts`

Find the `DatabaseSource` interface (around line 15-40) and add the optional `instanceName` property:

```typescript
export interface DatabaseSource {
  id: string;
  dsn?: string;
  type?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  instanceName?: string; // Add this line for SQL Server named instances
  readonly?: boolean;
  max_rows?: number;
  // SSH tunnel configuration
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_password?: string;
  ssh_key?: string;
  ssh_passphrase?: string;
}
```

### Step 4: Update buildDSNFromSource to include instanceName

**File:** `src/config/toml-loader.ts`

Find the `buildDSNFromSource` function (around line 100-200). Locate the SQL Server case and modify it to include instanceName in query parameters:

```typescript
    case 'sqlserver': {
      const params = new URLSearchParams();
      if (source.instanceName) {
        params.append('instanceName', source.instanceName);
      }
      const queryString = params.toString();
      return `sqlserver://${user}:${password}@${host}:${port}/${database}${queryString ? `?${queryString}` : ''}`;
    }
```

### Step 5: Run test to verify it passes

```bash
pnpm test src/config/__tests__/toml-loader.test.ts -t "instanceName"
```

**Expected output:** PASS - Both tests pass

### Step 6: Commit

```bash
git add src/types/config.ts src/config/toml-loader.ts src/config/__tests__/toml-loader.test.ts
git commit -m "feat(config): add instanceName support to TOML configuration"
```

---

## Task 3: Update Documentation

**Files:**
- Modify: `CLAUDE.md:132-137` (DSN examples section)
- Modify: `docs/config/server-options.mdx:34-42` (SQL Server tab)
- Create: `dbhub.toml.example` (add named instance example if not present)

### Step 1: Update CLAUDE.md with named instance example

**File:** `CLAUDE.md`

Replace line 135 with:

```markdown
  - SQL Server: `sqlserver://user:password@localhost:1433/dbname?sslmode=disable`
  - SQL Server (named instance): `sqlserver://user:password@localhost:1433/dbname?instanceName=ENV1`
```

### Step 2: Update docs/config/server-options.mdx

**File:** `docs/config/server-options.mdx`

Replace lines 36-41 with:

```markdown
      # Format: sqlserver://[user]:[password]@[host]:[port]/[database]?[options]
      sqlserver://sa:YourPassword123@localhost:1433/mydb

      # Named instance (e.g., ENV1, ENV2, ENV3)
      sqlserver://sa:YourPassword123@localhost:1433/mydb?instanceName=ENV1

      # Azure AD authentication
      sqlserver://username@localhost:1433/mydb?authentication=azure-active-directory-access-token
```

### Step 3: Add TOML example to dbhub.toml.example

**File:** `dbhub.toml.example`

Add a SQL Server named instance example in the sources section:

```toml
# SQL Server named instance example
# Multiple named instances on single host (ENV1 on port 1433, ENV2 on port 1434, etc.)
[[sources]]
id = "sqlserver_env1"
type = "sqlserver"
host = "127.0.0.1"
port = 1433
database = "Inventory"
user = "sa"
password = "YourPassword123"
instanceName = "ENV1"
readonly = false

[[sources]]
id = "sqlserver_env2"
type = "sqlserver"
host = "127.0.0.1"
port = 1434
database = "Inventory"
user = "sa"
password = "YourPassword123"
instanceName = "ENV2"
readonly = false
```

### Step 4: Verify documentation builds (if applicable)

```bash
# If there's a docs build command
pnpm run build:docs || echo "No docs build command, skip"
```

### Step 5: Commit

```bash
git add CLAUDE.md docs/config/server-options.mdx dbhub.toml.example
git commit -m "docs: add SQL Server named instance examples and configuration"
```

---

## Task 4: Update Sample DSN in DSNParser

**Files:**
- Modify: `src/connectors/sqlserver/index.ts:110-112` (getSampleDSN method)

### Step 1: Update getSampleDSN to show instanceName option

**File:** `src/connectors/sqlserver/index.ts`

Replace lines 110-112:

```typescript
  getSampleDSN(): string {
    return "sqlserver://username:password@localhost:1433/database?sslmode=disable&instanceName=INSTANCE1";
  }
```

### Step 2: Verify error message shows new format

Create a quick test:

```bash
pnpm dev -- --dsn="invalid://test" 2>&1 | grep -A 2 "Expected:"
```

**Expected:** Error message should show the updated DSN format with instanceName

### Step 3: Commit

```bash
git add src/connectors/sqlserver/index.ts
git commit -m "docs(sqlserver): update sample DSN to include instanceName example"
```

---

## Task 5: Add README or Issue Comment Documentation

**Files:**
- Modify: `README.md` (if SQL Server examples exist) OR create GitHub comment

### Step 1: Document the feature in README

**File:** `README.md`

If README has a SQL Server section, add named instance documentation. Otherwise, skip to Step 2.

### Step 2: Prepare GitHub issue response

Draft a comment for issue #112 explaining the implementation:

```markdown
## Named Instance Support Implemented

DBHub now supports SQL Server named instances! 🎉

### DSN Format

Use the `instanceName` query parameter:

```
sqlserver://username:password@host:port/database?instanceName=ENV1
```

### TOML Configuration

```toml
[[sources]]
id = "env1_instance"
type = "sqlserver"
host = "127.0.0.1"
port = 1433
database = "Inventory"
user = "sa"
password = "YourPassword"
instanceName = "ENV1"
```

### Examples

Your setup with three named instances (ENV1, ENV2, ENV3) on ports 1433, 1434, 1435:

```toml
[[sources]]
id = "env1"
type = "sqlserver"
host = "127.0.0.1"
port = 1433
instanceName = "ENV1"
database = "YourDB"
user = "sa"
password = "YourPassword"

[[sources]]
id = "env2"
type = "sqlserver"
host = "127.0.0.1"
port = 1434
instanceName = "ENV2"
database = "YourDB"
user = "sa"
password = "YourPassword"

[[sources]]
id = "env3"
type = "sqlserver"
host = "127.0.0.1"
port = 1435
instanceName = "ENV3"
database = "YourDB"
user = "sa"
password = "YourPassword"
```

### Requirements

- SQL Server Browser service must be running on the database server
- UDP port 1434 must be reachable on the database server

### Testing

Run the test suite:
```bash
pnpm test src/connectors/__tests__/sqlserver.integration.test.ts -t "Named Instance"
```
```

Save this as a draft comment (don't post yet - will post after PR is merged).

### Step 3: Commit

```bash
git add README.md  # if modified
git commit -m "docs: add named instance documentation"
```

---

## Task 6: Run Full Test Suite and Build

### Step 1: Run all SQL Server tests

```bash
pnpm test src/connectors/__tests__/sqlserver.integration.test.ts
```

**Expected:** All tests pass, including new named instance tests

### Step 2: Run full test suite

```bash
pnpm test
```

**Expected:** All tests pass across all connectors

### Step 3: Build the project

```bash
pnpm run build
```

**Expected:** Clean build with no TypeScript errors

### Step 4: Verify with demo mode (optional manual test)

If you have access to a SQL Server with named instances, test manually:

```bash
pnpm run dev -- --dsn="sqlserver://sa:YourPass@localhost:1433/testdb?instanceName=ENV1"
```

Then in an MCP client, try listing schemas and tables.

### Step 5: Final commit if any fixes needed

```bash
git add .
git commit -m "test: verify named instance implementation"
```

---

## Verification Checklist

- [ ] Unit tests pass for instanceName query parameter parsing
- [ ] Unit tests pass for TOML instanceName configuration
- [ ] Backward compatibility: connections without instanceName still work
- [ ] Documentation updated: CLAUDE.md, server-options.mdx, dbhub.toml.example
- [ ] Sample DSN updated to show instanceName usage
- [ ] Full test suite passes
- [ ] Build succeeds without errors
- [ ] TypeScript types updated (DatabaseSource interface)

---

## Notes for Engineer

### SQL Server Named Instance Background

Named instances allow multiple SQL Server installations on a single machine. The SQL Server Browser service (UDP 1434) helps clients locate named instances.

**Key points:**
1. The `mssql` library handles named instance resolution automatically when you provide `options.instanceName`
2. You still specify the port in the DSN (the port the named instance listens on)
3. The instanceName tells SQL Server Browser which instance you want
4. The format matches JDBC: `instanceName=VALUE` as a query parameter

### Testing Limitations

The integration tests use Docker containers without named instances. The tests verify:
- DSN parsing extracts instanceName correctly
- Config objects include instanceName in options
- Backward compatibility (no instanceName = existing behavior)

For manual testing with real named instances:
1. Ensure SQL Server Browser service is running
2. Ensure UDP 1434 is accessible
3. Use the correct port for your named instance

### Related Files Reference

- SQL Server connector: `src/connectors/sqlserver/index.ts`
- Integration tests: `src/connectors/__tests__/sqlserver.integration.test.ts`
- Config types: `src/types/config.ts`
- TOML loader: `src/config/toml-loader.ts`
- TOML tests: `src/config/__tests__/toml-loader.test.ts`

---

## Post-Implementation

After all tasks complete:

1. Create PR with title: "feat(sqlserver): add named instance support"
2. Reference issue #112 in PR description
3. Post the prepared GitHub comment on issue #112 after PR merges
4. Update any wiki or external documentation if applicable

**Estimated time:** 30-45 minutes for implementation + testing
