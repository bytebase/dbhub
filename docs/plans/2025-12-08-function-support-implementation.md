# Function Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add support for searching database functions as a distinct object type in the search_objects tool, separate from stored procedures.

**Architecture:** Extend the Connector interface with getFunctions() and getFunctionDetail() methods. Implement these methods in all database connectors by querying INFORMATION_SCHEMA.ROUTINES with ROUTINE_TYPE filters. Add "function" as a new object_type enum value in search-objects.ts with corresponding search handler.

**Tech Stack:** TypeScript, Node.js, PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, Zod for validation, Vitest for testing, Testcontainers for integration tests.

---

## Task 1: Extend Connector Interface

**Files:**
- Modify: `src/connectors/interface.ts:100-183` (Connector interface)

**Step 1: Add getFunctions() method to Connector interface**

After line 171 (after getStoredProcedures), add:

```typescript
  /**
   * Get functions in the database or in a specific schema
   * @param schema Optional schema name. If not provided, implementation should use the default schema
   * @returns Promise with array of function names
   */
  getFunctions(schema?: string): Promise<string[]>;
```

**Step 2: Add getFunctionDetail() method to Connector interface**

After the getFunctions() method, add:

```typescript
  /**
   * Get details for a specific function
   * @param functionName The name of the function to get details for
   * @param schema Optional schema name. If not provided, implementation should use the default schema
   * @returns Promise with function details (uses StoredProcedure type with procedure_type='function')
   */
  getFunctionDetail(functionName: string, schema?: string): Promise<StoredProcedure>;
```

**Step 3: Verify TypeScript compilation**

Run: `pnpm run build`
Expected: Should fail with errors about connectors not implementing new methods

**Step 4: Commit interface changes**

```bash
git add src/connectors/interface.ts
git commit -m "feat: add getFunctions and getFunctionDetail to Connector interface"
```

---

## Task 2: Implement PostgreSQL Connector Methods

**Files:**
- Modify: `src/connectors/postgres/index.ts:302-420` (Add methods after getStoredProcedureDetail)

**Step 1: Write failing integration test for getFunctions()**

In `src/connectors/__tests__/postgres.integration.test.ts`, add after the stored procedures tests (around line 400):

```typescript
describe("getFunctions", () => {
  it("should return list of function names", async () => {
    // Create a test function
    await connector.executeSQL(
      `CREATE OR REPLACE FUNCTION test_get_timestamp() RETURNS timestamp AS $$
        BEGIN RETURN NOW(); END;
      $$ LANGUAGE plpgsql`,
      { maxRows: 1 }
    );

    const functions = await connector.getFunctions("public");
    expect(functions).toContain("test_get_timestamp");

    // Clean up
    await connector.executeSQL("DROP FUNCTION IF EXISTS test_get_timestamp()", { maxRows: 1 });
  });

  it("should not return procedures in getFunctions", async () => {
    // Create a test procedure
    await connector.executeSQL(
      `CREATE OR REPLACE PROCEDURE test_log_procedure(msg TEXT) AS $$
        BEGIN RAISE NOTICE '%', msg; END;
      $$ LANGUAGE plpgsql`,
      { maxRows: 1 }
    );

    const functions = await connector.getFunctions("public");
    expect(functions).not.toContain("test_log_procedure");

    // Clean up
    await connector.executeSQL("DROP PROCEDURE IF EXISTS test_log_procedure(TEXT)", { maxRows: 1 });
  });
});

describe("getFunctionDetail", () => {
  it("should return function details with return type", async () => {
    // Create a test function with parameters
    await connector.executeSQL(
      `CREATE OR REPLACE FUNCTION test_add_numbers(a INT, b INT) RETURNS INT AS $$
        BEGIN RETURN a + b; END;
      $$ LANGUAGE plpgsql`,
      { maxRows: 1 }
    );

    const detail = await connector.getFunctionDetail("test_add_numbers", "public");
    expect(detail.procedure_name).toBe("test_add_numbers");
    expect(detail.procedure_type).toBe("function");
    expect(detail.return_type).toBe("integer");
    expect(detail.language).toBe("plpgsql");

    // Clean up
    await connector.executeSQL("DROP FUNCTION IF EXISTS test_add_numbers(INT, INT)", { maxRows: 1 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test postgres.integration.test.ts`
Expected: FAIL with "connector.getFunctions is not a function"

**Step 3: Implement getFunctions() in PostgreSQL connector**

In `src/connectors/postgres/index.ts`, add after getStoredProcedures method (around line 328):

```typescript
  async getFunctions(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || "public";

      // Get functions from PostgreSQL (exclude procedures)
      const result = await client.query(
        `
        SELECT
          routine_name
        FROM information_schema.routines
        WHERE routine_schema = $1
        AND routine_type = 'FUNCTION'
        ORDER BY routine_name
      `,
        [schemaToUse]
      );

      return result.rows.map((row) => row.routine_name);
    } finally {
      client.release();
    }
  }
```

**Step 4: Implement getFunctionDetail() in PostgreSQL connector**

Add after getFunctions method:

```typescript
  async getFunctionDetail(functionName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || "public";

      // Get function details from PostgreSQL
      const result = await client.query(
        `
        SELECT
          routine_name as procedure_name,
          routine_type,
          'function' as procedure_type,
          external_language as language,
          data_type as return_type,
          routine_definition as definition,
          (
            SELECT string_agg(
              parameter_name || ' ' ||
              parameter_mode || ' ' ||
              data_type,
              ', '
            )
            FROM information_schema.parameters
            WHERE specific_schema = $1
            AND specific_name = $2
            AND parameter_name IS NOT NULL
          ) as parameter_list
        FROM information_schema.routines
        WHERE routine_schema = $1
        AND routine_name = $2
        AND routine_type = 'FUNCTION'
      `,
        [schemaToUse, functionName]
      );

      if (result.rows.length === 0) {
        throw new Error(`Function '${functionName}' not found in schema '${schemaToUse}'`);
      }

      const func = result.rows[0];

      // If routine_definition is NULL, try to get the function body with pg_get_functiondef
      let definition = func.definition;

      try {
        const oidResult = await client.query(
          `
          SELECT p.oid, p.prosrc
          FROM pg_proc p
          JOIN pg_namespace n ON p.pronamespace = n.oid
          WHERE p.proname = $1
          AND n.nspname = $2
        `,
          [functionName, schemaToUse]
        );

        if (oidResult.rows.length > 0) {
          if (!definition) {
            const oid = oidResult.rows[0].oid;
            const defResult = await client.query(`SELECT pg_get_functiondef($1)`, [oid]);
            if (defResult.rows.length > 0) {
              definition = defResult.rows[0].pg_get_functiondef;
            } else {
              definition = oidResult.rows[0].prosrc;
            }
          }
        }
      } catch (err) {
        console.error(`Error getting function definition: ${err}`);
      }

      return {
        procedure_name: func.procedure_name,
        procedure_type: "function",
        language: func.language || "sql",
        parameter_list: func.parameter_list || "",
        return_type: func.return_type !== "void" ? func.return_type : undefined,
        definition: definition || undefined,
      };
    } finally {
      client.release();
    }
  }
```

**Step 5: Run test to verify it passes**

Run: `pnpm test postgres.integration.test.ts`
Expected: PASS

**Step 6: Commit PostgreSQL implementation**

```bash
git add src/connectors/postgres/index.ts src/connectors/__tests__/postgres.integration.test.ts
git commit -m "feat: implement getFunctions and getFunctionDetail for PostgreSQL"
```

---

## Task 3: Implement MySQL Connector Methods

**Files:**
- Modify: `src/connectors/mysql/index.ts:327-end` (Add methods after getStoredProcedureDetail)
- Modify: `src/connectors/__tests__/mysql.integration.test.ts` (Add tests)

**Step 1: Write failing integration test for getFunctions()**

In `src/connectors/__tests__/mysql.integration.test.ts`, add similar tests as PostgreSQL:

```typescript
describe("getFunctions", () => {
  it("should return list of function names", async () => {
    // Create a test function
    await connector.executeSQL(
      `CREATE FUNCTION test_get_current_time() RETURNS DATETIME
       DETERMINISTIC
       BEGIN RETURN NOW(); END`,
      { maxRows: 1 }
    );

    const functions = await connector.getFunctions();
    expect(functions).toContain("test_get_current_time");

    // Clean up
    await connector.executeSQL("DROP FUNCTION IF EXISTS test_get_current_time", { maxRows: 1 });
  });

  it("should not return procedures in getFunctions", async () => {
    // Create a test procedure
    await connector.executeSQL(
      `CREATE PROCEDURE test_log_procedure(IN msg TEXT)
       BEGIN SELECT msg; END`,
      { maxRows: 1 }
    );

    const functions = await connector.getFunctions();
    expect(functions).not.toContain("test_log_procedure");

    // Clean up
    await connector.executeSQL("DROP PROCEDURE IF EXISTS test_log_procedure", { maxRows: 1 });
  });
});

describe("getFunctionDetail", () => {
  it("should return function details with return type", async () => {
    // Create a test function with parameters
    await connector.executeSQL(
      `CREATE FUNCTION test_add_numbers(a INT, b INT) RETURNS INT
       DETERMINISTIC
       BEGIN RETURN a + b; END`,
      { maxRows: 1 }
    );

    const detail = await connector.getFunctionDetail("test_add_numbers");
    expect(detail.procedure_name).toBe("test_add_numbers");
    expect(detail.procedure_type).toBe("function");
    expect(detail.return_type).toBeDefined();

    // Clean up
    await connector.executeSQL("DROP FUNCTION IF EXISTS test_add_numbers", { maxRows: 1 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test mysql.integration.test.ts`
Expected: FAIL with "connector.getFunctions is not a function"

**Step 3: Implement getFunctions() in MySQL connector**

In `src/connectors/mysql/index.ts`, add after getStoredProcedureDetail method:

```typescript
  async getFunctions(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      // In MySQL, if no schema is provided, use the current database context
      const schemaClause = schema
        ? "WHERE ROUTINE_SCHEMA = ?"
        : "WHERE ROUTINE_SCHEMA = DATABASE()";

      const queryParams = schema ? [schema] : [];

      // Get functions only (exclude procedures)
      const [rows] = (await this.pool.query(
        `
        SELECT ROUTINE_NAME
        FROM INFORMATION_SCHEMA.ROUTINES
        ${schemaClause}
        AND ROUTINE_TYPE = 'FUNCTION'
        ORDER BY ROUTINE_NAME
      `,
        queryParams
      )) as [any[], any];

      return rows.map((row) => row.ROUTINE_NAME);
    } catch (error) {
      console.error("Error getting functions:", error);
      throw error;
    }
  }
```

**Step 4: Implement getFunctionDetail() in MySQL connector**

Add after getFunctions method:

```typescript
  async getFunctionDetail(functionName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaClause = schema
        ? "WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?"
        : "WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_NAME = ?";

      const queryParams = schema ? [schema, functionName] : [functionName];

      const [rows] = (await this.pool.query(
        `
        SELECT
          ROUTINE_NAME as procedure_name,
          ROUTINE_TYPE,
          'function' as procedure_type,
          ROUTINE_DEFINITION as definition,
          DATA_TYPE as return_type,
          EXTERNAL_LANGUAGE as language
        FROM INFORMATION_SCHEMA.ROUTINES
        ${schemaClause}
        AND ROUTINE_TYPE = 'FUNCTION'
      `,
        queryParams
      )) as [any[], any];

      if (rows.length === 0) {
        throw new Error(`Function '${functionName}' not found`);
      }

      const func = rows[0];

      // Get parameter information
      const paramSchemaClause = schema
        ? "WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ?"
        : "WHERE SPECIFIC_SCHEMA = DATABASE() AND SPECIFIC_NAME = ?";

      const [paramRows] = (await this.pool.query(
        `
        SELECT
          PARAMETER_NAME,
          DATA_TYPE,
          PARAMETER_MODE
        FROM INFORMATION_SCHEMA.PARAMETERS
        ${paramSchemaClause}
        ORDER BY ORDINAL_POSITION
      `,
        queryParams
      )) as [any[], any];

      const parameterList = paramRows
        .filter((p: any) => p.PARAMETER_NAME)
        .map((p: any) => `${p.PARAMETER_NAME} ${p.PARAMETER_MODE || ""} ${p.DATA_TYPE}`.trim())
        .join(", ");

      return {
        procedure_name: func.procedure_name,
        procedure_type: "function",
        language: func.language || "SQL",
        parameter_list: parameterList,
        return_type: func.return_type,
        definition: func.definition,
      };
    } catch (error) {
      console.error("Error getting function detail:", error);
      throw error;
    }
  }
```

**Step 5: Run test to verify it passes**

Run: `pnpm test mysql.integration.test.ts`
Expected: PASS

**Step 6: Commit MySQL implementation**

```bash
git add src/connectors/mysql/index.ts src/connectors/__tests__/mysql.integration.test.ts
git commit -m "feat: implement getFunctions and getFunctionDetail for MySQL"
```

---

## Task 4: Implement MariaDB Connector Methods

**Files:**
- Modify: `src/connectors/mariadb/index.ts` (Add methods after getStoredProcedureDetail)
- Modify: `src/connectors/__tests__/mariadb.integration.test.ts` (Add tests)

**Step 1: Write failing integration test for getFunctions()**

In `src/connectors/__tests__/mariadb.integration.test.ts`, add identical tests as MySQL (MariaDB uses same syntax).

**Step 2: Run test to verify it fails**

Run: `pnpm test mariadb.integration.test.ts`
Expected: FAIL with "connector.getFunctions is not a function"

**Step 3: Implement getFunctions() and getFunctionDetail() in MariaDB connector**

In `src/connectors/mariadb/index.ts`, add the exact same implementations as MySQL (MariaDB is compatible with MySQL syntax for INFORMATION_SCHEMA queries).

**Step 4: Run test to verify it passes**

Run: `pnpm test mariadb.integration.test.ts`
Expected: PASS

**Step 5: Commit MariaDB implementation**

```bash
git add src/connectors/mariadb/index.ts src/connectors/__tests__/mariadb.integration.test.ts
git commit -m "feat: implement getFunctions and getFunctionDetail for MariaDB"
```

---

## Task 5: Implement SQL Server Connector Methods

**Files:**
- Modify: `src/connectors/sqlserver/index.ts` (Add methods after getStoredProcedureDetail)
- Modify: `src/connectors/__tests__/sqlserver.integration.test.ts` (Add tests)

**Step 1: Write failing integration test for getFunctions()**

In `src/connectors/__tests__/sqlserver.integration.test.ts`, add:

```typescript
describe("getFunctions", () => {
  it("should return list of function names", async () => {
    // Create a test function
    await connector.executeSQL(
      `CREATE FUNCTION test_get_date() RETURNS DATETIME AS
       BEGIN RETURN GETDATE(); END`,
      { maxRows: 1 }
    );

    const functions = await connector.getFunctions("dbo");
    expect(functions).toContain("test_get_date");

    // Clean up
    await connector.executeSQL("DROP FUNCTION IF EXISTS test_get_date", { maxRows: 1 });
  });
});

describe("getFunctionDetail", () => {
  it("should return function details with return type", async () => {
    // Create a test function
    await connector.executeSQL(
      `CREATE FUNCTION test_add(@@a INT, @@b INT) RETURNS INT AS
       BEGIN RETURN @@a + @@b; END`,
      { maxRows: 1 }
    );

    const detail = await connector.getFunctionDetail("test_add", "dbo");
    expect(detail.procedure_name).toBe("test_add");
    expect(detail.procedure_type).toBe("function");

    // Clean up
    await connector.executeSQL("DROP FUNCTION IF EXISTS test_add", { maxRows: 1 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test sqlserver.integration.test.ts`
Expected: FAIL with "connector.getFunctions is not a function"

**Step 3: Implement getFunctions() in SQL Server connector**

In `src/connectors/sqlserver/index.ts`, add after getStoredProcedureDetail:

```typescript
  async getFunctions(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaToUse = schema || "dbo";

      const result = await this.pool
        .request()
        .input("schema", sql.NVarChar, schemaToUse)
        .query(`
          SELECT ROUTINE_NAME
          FROM INFORMATION_SCHEMA.ROUTINES
          WHERE ROUTINE_SCHEMA = @schema
          AND ROUTINE_TYPE = N'FUNCTION'
          ORDER BY ROUTINE_NAME
        `);

      return result.recordset.map((row) => row.ROUTINE_NAME);
    } catch (error) {
      console.error("Error getting functions:", error);
      throw error;
    }
  }
```

**Step 4: Implement getFunctionDetail() in SQL Server connector**

Add after getFunctions method:

```typescript
  async getFunctionDetail(functionName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.pool) {
      throw new Error("Not connected to database");
    }

    try {
      const schemaToUse = schema || "dbo";

      const result = await this.pool
        .request()
        .input("schema", sql.NVarChar, schemaToUse)
        .input("name", sql.NVarChar, functionName)
        .query(`
          SELECT
            ROUTINE_NAME as procedure_name,
            ROUTINE_TYPE,
            'function' as procedure_type,
            ROUTINE_DEFINITION as definition,
            DATA_TYPE as return_type
          FROM INFORMATION_SCHEMA.ROUTINES
          WHERE ROUTINE_SCHEMA = @schema
          AND ROUTINE_NAME = @name
          AND ROUTINE_TYPE = N'FUNCTION'
        `);

      if (result.recordset.length === 0) {
        throw new Error(`Function '${functionName}' not found in schema '${schemaToUse}'`);
      }

      const func = result.recordset[0];

      // Get parameter information
      const paramResult = await this.pool
        .request()
        .input("schema", sql.NVarChar, schemaToUse)
        .input("name", sql.NVarChar, functionName)
        .query(`
          SELECT
            PARAMETER_NAME,
            DATA_TYPE,
            PARAMETER_MODE
          FROM INFORMATION_SCHEMA.PARAMETERS
          WHERE SPECIFIC_SCHEMA = @schema
          AND SPECIFIC_NAME = @name
          ORDER BY ORDINAL_POSITION
        `);

      const parameterList = paramResult.recordset
        .filter((p: any) => p.PARAMETER_NAME)
        .map((p: any) => `${p.PARAMETER_NAME} ${p.PARAMETER_MODE || ""} ${p.DATA_TYPE}`.trim())
        .join(", ");

      return {
        procedure_name: func.procedure_name,
        procedure_type: "function",
        language: "T-SQL",
        parameter_list: parameterList,
        return_type: func.return_type,
        definition: func.definition,
      };
    } catch (error) {
      console.error("Error getting function detail:", error);
      throw error;
    }
  }
```

**Step 5: Run test to verify it passes**

Run: `pnpm test sqlserver.integration.test.ts`
Expected: PASS

**Step 6: Commit SQL Server implementation**

```bash
git add src/connectors/sqlserver/index.ts src/connectors/__tests__/sqlserver.integration.test.ts
git commit -m "feat: implement getFunctions and getFunctionDetail for SQL Server"
```

---

## Task 6: Implement SQLite Connector Methods

**Files:**
- Modify: `src/connectors/sqlite/index.ts` (Add methods after getStoredProcedureDetail)
- Modify: `src/connectors/__tests__/sqlite.integration.test.ts` (Add tests)

**Step 1: Write test for getFunctions() returning empty array**

In `src/connectors/__tests__/sqlite.integration.test.ts`, add:

```typescript
describe("getFunctions", () => {
  it("should return empty array (SQLite does not support functions)", async () => {
    const functions = await connector.getFunctions();
    expect(functions).toEqual([]);
  });
});

describe("getFunctionDetail", () => {
  it("should throw error (SQLite does not support functions)", async () => {
    await expect(connector.getFunctionDetail("test_func")).rejects.toThrow(
      "SQLite does not support stored functions"
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test sqlite.integration.test.ts`
Expected: FAIL with "connector.getFunctions is not a function"

**Step 3: Implement getFunctions() in SQLite connector**

In `src/connectors/sqlite/index.ts`, add after getStoredProcedureDetail:

```typescript
  async getFunctions(schema?: string): Promise<string[]> {
    // SQLite does not support stored functions
    return [];
  }
```

**Step 4: Implement getFunctionDetail() in SQLite connector**

Add after getFunctions method:

```typescript
  async getFunctionDetail(functionName: string, schema?: string): Promise<StoredProcedure> {
    throw new Error("SQLite does not support stored functions");
  }
```

**Step 5: Run test to verify it passes**

Run: `pnpm test sqlite.integration.test.ts`
Expected: PASS

**Step 6: Commit SQLite implementation**

```bash
git add src/connectors/sqlite/index.ts src/connectors/__tests__/sqlite.integration.test.ts
git commit -m "feat: implement getFunctions and getFunctionDetail for SQLite (no-op)"
```

---

## Task 7: Update search-objects Tool - Types and Schema

**Files:**
- Modify: `src/tools/search-objects.ts:10,23` (Update types and schema)

**Step 1: Update DatabaseObjectType enum**

In `src/tools/search-objects.ts`, line 10, change:

```typescript
export type DatabaseObjectType = "schema" | "table" | "column" | "procedure" | "function" | "index";
```

**Step 2: Update zod schema enum**

In `src/tools/search-objects.ts`, line 23, change:

```typescript
  object_type: z
    .enum(["schema", "table", "column", "procedure", "function", "index"])
    .describe("Type of database object to search for"),
```

**Step 3: Verify TypeScript compilation**

Run: `pnpm run build`
Expected: BUILD SUCCESS

**Step 4: Commit type and schema updates**

```bash
git add src/tools/search-objects.ts
git commit -m "feat: add function to DatabaseObjectType enum and schema"
```

---

## Task 8: Implement searchFunctions Helper

**Files:**
- Modify: `src/tools/search-objects.ts:430` (Add searchFunctions after searchIndexes)

**Step 1: Write failing unit test for searchFunctions**

In `src/tools/__tests__/search-objects.test.ts`, add after the procedure tests:

```typescript
describe("search_objects with object_type=function", () => {
  it("should search functions with names detail level", async () => {
    const mockConnector = {
      getFunctions: vi.fn().mockResolvedValue(["get_timestamp", "add_numbers"]),
      getSchemas: vi.fn().mockResolvedValue(["public"]),
    };

    ConnectorManager.getCurrentConnector = vi.fn().mockReturnValue(mockConnector);

    const handler = createSearchDatabaseObjectsToolHandler();
    const result = await handler(
      {
        object_type: "function",
        pattern: "%",
        detail_level: "names",
        limit: 100,
      },
      {}
    );

    expect(result.content[0].text).toContain("get_timestamp");
    expect(result.content[0].text).toContain("add_numbers");
    expect(mockConnector.getFunctions).toHaveBeenCalledWith(undefined);
  });

  it("should search functions with summary detail level", async () => {
    const mockConnector = {
      getFunctions: vi.fn().mockResolvedValue(["add_numbers"]),
      getFunctionDetail: vi.fn().mockResolvedValue({
        procedure_name: "add_numbers",
        procedure_type: "function",
        language: "plpgsql",
        return_type: "integer",
        parameter_list: "a integer, b integer",
      }),
      getSchemas: vi.fn().mockResolvedValue(["public"]),
    };

    ConnectorManager.getCurrentConnector = vi.fn().mockReturnValue(mockConnector);

    const handler = createSearchDatabaseObjectsToolHandler();
    const result = await handler(
      {
        object_type: "function",
        pattern: "%",
        detail_level: "summary",
        limit: 100,
      },
      {}
    );

    expect(result.content[0].text).toContain("add_numbers");
    expect(result.content[0].text).toContain("integer");
    expect(mockConnector.getFunctionDetail).toHaveBeenCalledWith("add_numbers", undefined);
  });

  it("should search functions with full detail level", async () => {
    const mockConnector = {
      getFunctions: vi.fn().mockResolvedValue(["add_numbers"]),
      getFunctionDetail: vi.fn().mockResolvedValue({
        procedure_name: "add_numbers",
        procedure_type: "function",
        language: "plpgsql",
        return_type: "integer",
        parameter_list: "a integer, b integer",
        definition: "BEGIN RETURN a + b; END;",
      }),
      getSchemas: vi.fn().mockResolvedValue(["public"]),
    };

    ConnectorManager.getCurrentConnector = vi.fn().mockReturnValue(mockConnector);

    const handler = createSearchDatabaseObjectsToolHandler();
    const result = await handler(
      {
        object_type: "function",
        pattern: "%",
        detail_level: "full",
        limit: 100,
      },
      {}
    );

    expect(result.content[0].text).toContain("add_numbers");
    expect(result.content[0].text).toContain("BEGIN RETURN a + b; END;");
  });

  it("should filter functions by pattern", async () => {
    const mockConnector = {
      getFunctions: vi.fn().mockResolvedValue(["get_timestamp", "add_numbers", "get_user"]),
      getSchemas: vi.fn().mockResolvedValue(["public"]),
    };

    ConnectorManager.getCurrentConnector = vi.fn().mockReturnValue(mockConnector);

    const handler = createSearchDatabaseObjectsToolHandler();
    const result = await handler(
      {
        object_type: "function",
        pattern: "get%",
        detail_level: "names",
        limit: 100,
      },
      {}
    );

    expect(result.content[0].text).toContain("get_timestamp");
    expect(result.content[0].text).toContain("get_user");
    expect(result.content[0].text).not.toContain("add_numbers");
  });

  it("should filter functions by schema", async () => {
    const mockConnector = {
      getFunctions: vi.fn().mockResolvedValue(["my_function"]),
      getSchemas: vi.fn().mockResolvedValue(["public", "custom"]),
    };

    ConnectorManager.getCurrentConnector = vi.fn().mockReturnValue(mockConnector);

    const handler = createSearchDatabaseObjectsToolHandler();
    const result = await handler(
      {
        object_type: "function",
        pattern: "%",
        schema: "custom",
        detail_level: "names",
        limit: 100,
      },
      {}
    );

    expect(mockConnector.getFunctions).toHaveBeenCalledWith("custom");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test search-objects.test.ts`
Expected: FAIL (searchFunctions not implemented)

**Step 3: Implement searchFunctions helper**

In `src/tools/search-objects.ts`, add after searchIndexes function (around line 430):

```typescript
/**
 * Search for functions
 */
async function searchFunctions(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]> {
  const regex = likePatternToRegex(pattern);
  const results: any[] = [];

  // Get schemas to search
  let schemasToSearch: string[];
  if (schemaFilter) {
    schemasToSearch = [schemaFilter];
  } else {
    schemasToSearch = await connector.getSchemas();
  }

  // Search functions in each schema
  for (const schemaName of schemasToSearch) {
    if (results.length >= limit) break;

    try {
      const functions = await connector.getFunctions(schemaName);
      const matched = functions.filter((func: string) => regex.test(func));

      for (const funcName of matched) {
        if (results.length >= limit) break;

        if (detailLevel === "names") {
          results.push({
            name: funcName,
            schema: schemaName,
          });
        } else {
          // summary and full - get function details
          try {
            const details = await connector.getFunctionDetail(funcName, schemaName);
            results.push({
              name: funcName,
              schema: schemaName,
              type: details.procedure_type,
              language: details.language,
              return_type: details.return_type,
              parameters: detailLevel === "full" ? details.parameter_list : undefined,
              definition: detailLevel === "full" ? details.definition : undefined,
            });
          } catch (error) {
            results.push({
              name: funcName,
              schema: schemaName,
              error: `Unable to fetch details: ${(error as Error).message}`,
            });
          }
        }
      }
    } catch (error) {
      // Skip schemas we can't access or databases that don't support functions
      continue;
    }
  }

  return results;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test search-objects.test.ts`
Expected: PASS

**Step 5: Commit searchFunctions implementation**

```bash
git add src/tools/search-objects.ts src/tools/__tests__/search-objects.test.ts
git commit -m "feat: implement searchFunctions helper for search-objects tool"
```

---

## Task 9: Add Function Case to Handler Routing

**Files:**
- Modify: `src/tools/search-objects.ts:485` (Add case in switch statement)

**Step 1: Add function case to switch statement**

In `src/tools/search-objects.ts`, in the `createSearchDatabaseObjectsToolHandler` function, add after the procedure case (around line 485):

```typescript
      case "function":
        results = await searchFunctions(connector, pattern, schema, detail_level, limit);
        break;
```

**Step 2: Run unit tests to verify routing works**

Run: `pnpm test search-objects.test.ts`
Expected: PASS (all tests including new function tests should pass)

**Step 3: Run integration tests to verify end-to-end**

Run: `pnpm test:integration`
Expected: PASS (all connector integration tests should pass)

**Step 4: Commit handler routing update**

```bash
git add src/tools/search-objects.ts
git commit -m "feat: add function case to search handler routing logic"
```

---

## Task 10: Update Documentation

**Files:**
- Modify: `docs/tools/search-objects.mdx` (Add function examples)
- Modify: `CLAUDE.md` (Update architecture overview)

**Step 1: Update search-objects.mdx**

Add function to the object types section and add examples:

```markdown
### Supported Object Types

- `schema`: Database schemas/databases
- `table`: Database tables
- `column`: Table columns
- `procedure`: Stored procedures
- `function`: Stored functions (PostgreSQL, MySQL, MariaDB, SQL Server)
- `index`: Table indexes

### Database Compatibility

Function search is supported on:
- PostgreSQL ✓
- MySQL ✓
- MariaDB ✓
- SQL Server ✓
- SQLite ✗ (returns empty results)

### Examples

#### Search for functions

Search for all functions starting with "get":

```json
{
  "object_type": "function",
  "pattern": "get%",
  "detail_level": "summary"
}
```

Example response:
```json
{
  "object_type": "function",
  "pattern": "get%",
  "count": 2,
  "results": [
    {
      "name": "get_timestamp",
      "schema": "public",
      "type": "function",
      "language": "plpgsql",
      "return_type": "timestamp"
    },
    {
      "name": "get_user_count",
      "schema": "public",
      "type": "function",
      "language": "sql",
      "return_type": "integer"
    }
  ]
}
```
```

**Step 2: Update CLAUDE.md**

Update the tool list to mention functions:

```markdown
- `search_objects`: Single tool for both pattern-based search and listing all objects
- Supports: schemas, tables, columns, procedures, functions, indexes
```

**Step 3: Verify documentation builds (if applicable)**

If there's a docs build command, run it to ensure no syntax errors.

**Step 4: Commit documentation updates**

```bash
git add docs/tools/search-objects.mdx CLAUDE.md
git commit -m "docs: add function support to search-objects documentation"
```

---

## Task 11: Final Integration Test and Verification

**Files:**
- N/A (verification only)

**Step 1: Run all unit tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 2: Run all integration tests**

Run: `pnpm test:integration`
Expected: ALL PASS

**Step 3: Build the project**

Run: `pnpm run build`
Expected: BUILD SUCCESS with no errors

**Step 4: Manual verification test (optional)**

Start the dev server and test with a real database:

```bash
pnpm run dev --dsn="postgres://user:pass@localhost:5432/testdb"
```

Test the search_objects tool with object_type="function" via MCP client.

**Step 5: Review all commits**

Run: `git log --oneline -15`
Expected: See all commits from this implementation

**Step 6: Final commit (if any cleanup needed)**

If any final cleanup or adjustments:

```bash
git add .
git commit -m "chore: final cleanup for function support feature"
```

---

## Completion Checklist

- [ ] Connector interface extended with getFunctions() and getFunctionDetail()
- [ ] PostgreSQL connector implements function methods
- [ ] MySQL connector implements function methods
- [ ] MariaDB connector implements function methods
- [ ] SQL Server connector implements function methods
- [ ] SQLite connector implements function methods (no-op)
- [ ] DatabaseObjectType enum includes "function"
- [ ] searchFunctions() helper implemented
- [ ] Handler routing includes function case
- [ ] Unit tests pass for search-objects tool
- [ ] Integration tests pass for all connectors
- [ ] Documentation updated (search-objects.mdx, CLAUDE.md)
- [ ] Build successful with no TypeScript errors
- [ ] All tests passing

## Notes

- Each connector has slightly different SQL syntax for querying INFORMATION_SCHEMA.ROUTINES
- PostgreSQL uses pg_get_functiondef for full function definitions
- SQLite doesn't support stored functions, so it returns empty arrays
- The StoredProcedure interface is reused for functions (has procedure_type discriminator)
- Tests use real database containers via Testcontainers for integration testing
