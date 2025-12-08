# Function Support in search_objects Tool

## Overview

Add support for searching database functions as a distinct object type in the `search_objects` tool. Currently, the tool supports searching for procedures, but functions and procedures are mixed together. This design separates them into distinct searchable types.

## Problem Statement

Database systems distinguish between stored procedures and functions:
- **Functions**: Return a value, can be used in expressions
- **Procedures**: Perform actions, don't return values (or return void)

Currently, DBHub's `search_objects` tool only has a "procedure" object type, which returns both procedures and functions mixed together. Users cannot filter to search only for functions.

## Goals

1. Add "function" as a separate object_type in the search_objects tool
2. Allow users to search specifically for functions or procedures
3. Maintain backward compatibility with existing code
4. Support all databases that have function capabilities (PostgreSQL, MySQL, MariaDB, SQL Server)

## Non-Goals

- Changing how procedures are searched (backward compatible)
- Adding function execution capabilities
- Supporting SQLite functions (SQLite doesn't have stored routines)

## Design

### 1. Connector Interface Changes

**File**: `src/connectors/interface.ts`

Add two new methods to the `Connector` interface:

```typescript
/**
 * Get functions in the database or in a specific schema
 * @param schema Optional schema name. If not provided, implementation should use the default schema
 * @returns Promise with array of function names
 */
getFunctions(schema?: string): Promise<string[]>;

/**
 * Get details for a specific function
 * @param functionName The name of the function to get details for
 * @param schema Optional schema name. If not provided, implementation should use the default schema
 * @returns Promise with function details (uses StoredProcedure type with procedure_type='function')
 */
getFunctionDetail(functionName: string, schema?: string): Promise<StoredProcedure>;
```

**Why reuse StoredProcedure type?**
The existing `StoredProcedure` interface already has:
- `procedure_type: "procedure" | "function"` discriminator
- All necessary fields: `return_type`, `definition`, `parameter_list`, `language`
- No need to duplicate with a separate Function type

### 2. Search Objects Tool Changes

**File**: `src/tools/search-objects.ts`

#### Type Updates

```typescript
export type DatabaseObjectType = "schema" | "table" | "column" | "procedure" | "function" | "index";
```

#### Schema Updates

```typescript
export const searchDatabaseObjectsSchema = {
  object_type: z
    .enum(["schema", "table", "column", "procedure", "function", "index"])
    .describe("Type of database object to search for"),
  // ... rest unchanged
};
```

#### New Search Function

```typescript
async function searchFunctions(
  connector: Connector,
  pattern: string,
  schemaFilter: string | undefined,
  detailLevel: DetailLevel,
  limit: number
): Promise<any[]>
```

This function will:
- Mirror the structure of `searchProcedures()`
- Call `connector.getFunctions()` to get function names
- Call `connector.getFunctionDetail()` for detail levels
- Support all three detail levels: names, summary, full

#### Handler Routing

Add new case to the switch statement in `createSearchDatabaseObjectsToolHandler()`:

```typescript
case "function":
  results = await searchFunctions(connector, pattern, schema, detail_level, limit);
  break;
```

#### Result Format

**Detail level: names**
```json
{
  "name": "add_numbers",
  "schema": "public"
}
```

**Detail level: summary**
```json
{
  "name": "add_numbers",
  "schema": "public",
  "type": "function",
  "language": "plpgsql",
  "return_type": "integer"
}
```

**Detail level: full**
```json
{
  "name": "add_numbers",
  "schema": "public",
  "type": "function",
  "language": "plpgsql",
  "parameters": "a integer, b integer",
  "return_type": "integer",
  "definition": "BEGIN\n  RETURN a + b;\nEND;"
}
```

### 3. Connector Implementations

Each database connector implements the two new methods by querying `INFORMATION_SCHEMA.ROUTINES` with a routine type filter.

#### PostgreSQL (`src/connectors/postgres/index.ts`)

```typescript
async getFunctions(schema?: string): Promise<string[]> {
  const schemaToUse = schema || "public";
  const result = await client.query(`
    SELECT routine_name
    FROM information_schema.routines
    WHERE routine_schema = $1
    AND routine_type = 'FUNCTION'
    ORDER BY routine_name
  `, [schemaToUse]);
  return result.rows.map((row) => row.routine_name);
}

async getFunctionDetail(functionName: string, schema?: string): Promise<StoredProcedure> {
  // Similar to getStoredProcedureDetail but filter for routine_type = 'FUNCTION'
  // Use pg_get_functiondef for definition
}
```

#### MySQL/MariaDB (`src/connectors/mysql/index.ts`, `src/connectors/mariadb/index.ts`)

```typescript
async getFunctions(schema?: string): Promise<string[]> {
  const schemaClause = schema
    ? "WHERE ROUTINE_SCHEMA = ?"
    : "WHERE ROUTINE_SCHEMA = DATABASE()";

  const [rows] = await this.pool.query(`
    SELECT ROUTINE_NAME
    FROM INFORMATION_SCHEMA.ROUTINES
    ${schemaClause}
    AND ROUTINE_TYPE = 'FUNCTION'
    ORDER BY ROUTINE_NAME
  `, schema ? [schema] : []);

  return rows.map((row) => row.ROUTINE_NAME);
}
```

#### SQL Server (`src/connectors/sqlserver/index.ts`)

```typescript
async getFunctions(schema?: string): Promise<string[]> {
  const schemaToUse = schema || "dbo";
  const result = await this.pool.request()
    .input("schema", sql.NVarChar, schemaToUse)
    .query(`
      SELECT ROUTINE_NAME
      FROM INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_SCHEMA = @schema
      AND ROUTINE_TYPE = N'FUNCTION'
      ORDER BY ROUTINE_NAME
    `);
  return result.recordset.map((row) => row.ROUTINE_NAME);
}
```

#### SQLite (`src/connectors/sqlite/index.ts`)

```typescript
async getFunctions(schema?: string): Promise<string[]> {
  // SQLite doesn't support stored functions
  return [];
}

async getFunctionDetail(functionName: string, schema?: string): Promise<StoredProcedure> {
  throw new Error("SQLite does not support stored functions");
}
```

#### Code Reuse Strategy

To avoid duplication between `getStoredProcedures()` and `getFunctions()`, extract a private helper:

```typescript
private async _getRoutines(
  schema: string | undefined,
  routineType: 'FUNCTION' | 'PROCEDURE'
): Promise<string[]>
```

Then both public methods call this helper with the appropriate type.

### 4. Testing Strategy

#### Unit Tests (`src/tools/__tests__/search-objects.test.ts`)

Add test cases for the new function object type:

```typescript
describe("search_objects with object_type=function", () => {
  it("should search functions with names detail level", async () => {
    // Mock connector.getFunctions()
    // Assert correct results format
  });

  it("should search functions with summary detail level", async () => {
    // Test that return_type and language are included
  });

  it("should search functions with full detail level", async () => {
    // Test that parameters and definition are included
  });

  it("should filter functions by pattern", async () => {
    // Test SQL LIKE pattern matching
  });

  it("should filter functions by schema", async () => {
    // Test schema filtering
  });
});
```

#### Integration Tests (`src/connectors/__tests__/*.integration.test.ts`)

For each supported database (PostgreSQL, MySQL, MariaDB, SQL Server):

**Test Setup**: Create test functions in the database:
```sql
-- PostgreSQL example
CREATE FUNCTION get_timestamp() RETURNS timestamp AS $$
  BEGIN RETURN NOW(); END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION add_numbers(a INT, b INT) RETURNS INT AS $$
  BEGIN RETURN a + b; END;
$$ LANGUAGE plpgsql;

CREATE PROCEDURE log_message(msg TEXT) AS $$
  BEGIN RAISE NOTICE '%', msg; END;
$$ LANGUAGE plpgsql;
```

**Test Cases**:
1. `getFunctions()` returns only functions, not procedures
2. `getStoredProcedures()` returns only procedures, not functions
3. `getFunctionDetail()` returns correct metadata for functions
4. `search_objects` with `object_type="function"` returns only functions
5. Pattern matching works with function names
6. Schema filtering works correctly

**SQLite Tests**:
- Verify `getFunctions()` returns empty array
- Verify searching for functions returns empty results gracefully

### 5. Documentation Updates

#### Tool Documentation (`docs/tools/search-objects.mdx`)

Add function examples:

```markdown
### Object Types

- `schema`: Database schemas/databases
- `table`: Database tables
- `column`: Table columns
- `procedure`: Stored procedures
- `function`: Stored functions (PostgreSQL, MySQL, MariaDB, SQL Server)
- `index`: Table indexes

### Examples

Search for functions starting with "get":
```json
{
  "object_type": "function",
  "pattern": "get%",
  "detail_level": "summary"
}
```

**Database Compatibility**: Function search is supported on PostgreSQL, MySQL, MariaDB, and SQL Server. SQLite does not support stored functions and will return empty results.
```

#### CLAUDE.md

Update the architecture overview to mention function support:

```markdown
- `search_objects`: Single tool for both pattern-based search and listing all objects
- Supports: schemas, tables, columns, procedures, functions, indexes
```

#### Connector Interface JSDoc (`src/connectors/interface.ts`)

Add comprehensive JSDoc comments for the new methods with examples and database-specific notes.

## Backward Compatibility

This change is **fully backward compatible**:

1. **No breaking changes**: All existing method signatures remain unchanged
2. **Additive only**: New methods added to interface, existing methods untouched
3. **Enum expansion**: Adding "function" to the object_type enum doesn't break existing code
4. **Existing behavior preserved**: Searching for "procedure" continues to work exactly as before
5. **Type safety maintained**: TypeScript will enforce implementation of new methods

## Migration Path

No migration required. This is a pure feature addition:

- **Current behavior**: Users search for "procedure" to find stored procedures
- **New behavior**: Users can search for "function" to find functions specifically
- **Adoption**: Users can adopt the new functionality at their own pace

## Implementation Checklist

- [ ] Extend Connector interface with `getFunctions()` and `getFunctionDetail()` methods
- [ ] Implement `getFunctions()` in all connectors (PostgreSQL, MySQL, MariaDB, SQL Server, SQLite)
- [ ] Implement `getFunctionDetail()` in all connectors
- [ ] Add "function" to `DatabaseObjectType` enum in search-objects.ts
- [ ] Implement `searchFunctions()` helper function
- [ ] Add "function" case to search handler routing logic
- [ ] Update search_objects zod schema to include "function"
- [ ] Write unit tests for function search functionality
- [ ] Write integration tests for each database connector
- [ ] Update docs/tools/search-objects.mdx with function examples
- [ ] Update CLAUDE.md architecture documentation
- [ ] Add JSDoc comments to new connector interface methods

## Open Questions

None - design is ready for implementation.
