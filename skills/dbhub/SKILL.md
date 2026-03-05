---
name: dbhub
description: Guide for querying databases through DBHub MCP server. Use this skill whenever you need to explore database schemas, inspect tables, or run SQL queries via DBHub's MCP tools (search_objects, execute_sql). Activates on any database query task, schema exploration, data retrieval, or SQL execution through MCP — even if the user just says "check the database" or "find me some data." This skill ensures you follow the correct explore-first workflow instead of guessing table structures.
---

# DBHub Database Query Guide

When working with databases through DBHub's MCP server, always follow the **explore-then-query** pattern. Jumping straight to SQL without understanding the schema is the most common mistake — it leads to failed queries, wasted tokens, and frustrated users.

## Available Tools

DBHub provides two MCP tools:

| Tool | Purpose |
|------|---------|
| `search_objects` | Explore database structure — schemas, tables, columns, indexes, procedures, functions |
| `execute_sql` | Run SQL statements against the database |

If multiple databases are configured, DBHub registers separate tools for each source (for example, `search_objects_prod_pg`, `execute_sql_staging_mysql`). Select the desired database by calling the correspondingly named tool.

## The Explore-Then-Query Workflow

Every database task should follow this progression. The key insight is that each step narrows your focus, so you never waste tokens loading information you don't need.

### Step 1: Discover what schemas exist

```
search_objects(object_type="schema", detail_level="names")
```

This tells you the lay of the land. Most databases have a primary schema (e.g., `public` in PostgreSQL, `dbo` in SQL Server) plus system schemas you can ignore.

### Step 2: Find relevant tables

Once you know the schema, list its tables:

```
search_objects(object_type="table", schema="public", detail_level="names")
```

If you're looking for something specific, use a pattern:

```
search_objects(object_type="table", schema="public", pattern="%user%", detail_level="names")
```

The `pattern` parameter uses SQL LIKE syntax: `%` matches any characters, `_` matches a single character.

If you need more context to identify the right table (row counts, column counts, table comments), use `detail_level="summary"` instead.

### Step 3: Inspect table structure

Before writing any query, understand the columns:

```
search_objects(object_type="column", schema="public", table="users", detail_level="full")
```

This returns column names, data types, nullability, and defaults — everything you need to write correct SQL.

For understanding query performance or join patterns, also check indexes:

```
search_objects(object_type="index", schema="public", table="users", detail_level="full")
```

### Step 4: Write and execute the query

Now that you know the exact table and column names, write precise SQL:

```
execute_sql(sql="SELECT id, email, created_at FROM public.users WHERE created_at > '2024-01-01' ORDER BY created_at DESC")
```

## Progressive Disclosure: Choosing the Right Detail Level

The `detail_level` parameter controls how much information `search_objects` returns. Start minimal and drill down only where needed — this keeps responses fast and token-efficient.

| Level | What you get | When to use |
|-------|-------------|-------------|
| `names` | Just object names | Browsing, finding the right table |
| `summary` | Names + metadata (row count, column count, comments) | Choosing between similar tables, understanding data volume |
| `full` | Complete structure (columns with types, indexes, procedure definitions) | Before writing queries, understanding relationships |

**Rule of thumb:** Use `names` for broad exploration, `summary` for narrowing down, and `full` only for the specific tables you'll query.

## Working with Multiple Databases

When DBHub is configured with multiple database sources, it registers separate tool instances for each source. The tool names follow the pattern `{tool}_{source_id}`:

```
# Query the production PostgreSQL database
search_objects_prod_pg(object_type="table", schema="public", detail_level="names")
execute_sql_prod_pg(sql="SELECT count(*) FROM orders")

# Query the staging MySQL database
search_objects_staging_mysql(object_type="table", detail_level="names")
execute_sql_staging_mysql(sql="SELECT count(*) FROM orders")
```

In single-database setups, the tools are simply `search_objects` and `execute_sql` without any suffix. When the user mentions a specific database or environment, call the correspondingly named tool.

## Searching for Specific Objects

The `search_objects` tool supports targeted searches across all object types:

```
# Find all tables with "order" in the name
search_objects(object_type="table", pattern="%order%", detail_level="names")

# Find columns named "email" across all tables
search_objects(object_type="column", pattern="email", detail_level="names")

# Find stored procedures matching a pattern
search_objects(object_type="procedure", schema="public", pattern="%report%", detail_level="summary")

# Find functions
search_objects(object_type="function", schema="public", detail_level="names")
```

## Common Patterns

### "What data do we have?"
1. List schemas → list tables with `summary` detail → pick relevant tables → inspect with `full` detail

### "Get me X from the database"
1. Search for tables related to X → inspect columns → write targeted SELECT

### "How are these tables related?"
1. Inspect both tables at `full` detail (columns + indexes reveal foreign keys and join columns)

### "Run this specific SQL"
If the user provides exact SQL, you can execute it directly. But if it fails with a column or table error, fall back to the explore workflow rather than guessing fixes.

## Error Recovery

When a query fails:
- **Unknown table/column**: Use `search_objects` to find the correct names rather than guessing variations
- **Schema errors**: List available schemas first — the table may be in a different schema than expected
- **Permission errors**: The database may be in read-only mode; check if only SELECT statements are allowed
- **Multiple statements**: `execute_sql` supports multiple SQL statements separated by `;`

## What NOT to Do

- **Don't guess table or column names.** Always verify with `search_objects` first. A wrong guess wastes a round trip and confuses the conversation.
- **Don't dump entire schemas upfront.** Use progressive disclosure — start with `names`, drill into `full` only for tables you'll actually query.
- **Don't use the wrong tool in multi-database setups.** If the user mentions a specific database, call the source-specific tool variant (e.g., `execute_sql_prod_pg`) rather than the generic `execute_sql`.
- **Don't retry failed queries blindly.** If SQL fails, investigate the schema to understand why before retrying.
