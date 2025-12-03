# Startup Table Design

Display data sources and tools in a combined table view when the server starts.

## Design Decisions

- **Layout**: Grouped by source - source as header row, tools as bullet list beneath
- **Source info**: ID, database type, host:port/database, mode indicators (READ-ONLY, DEMO)
- **Tool info**: Name only (simple bullet points)
- **Visual style**: Unicode box drawing characters

## Example Output

```
┌─────────────────────────────────────────────────────────────┐
│ prod_pg (postgres) │ localhost:5432/mydb      │ READ-ONLY   │
├─────────────────────────────────────────────────────────────┤
│   • execute_sql                                             │
│   • search_objects                                          │
├─────────────────────────────────────────────────────────────┤
│ staging (mysql)    │ localhost:3306/staging   │             │
├─────────────────────────────────────────────────────────────┤
│   • execute_sql_staging                                     │
│   • search_objects_staging                                  │
│   • get_active_users                                        │
└─────────────────────────────────────────────────────────────┘
```

## Placement

After ASCII banner, before transport/endpoint info.

## Implementation

- Create `src/utils/startup-table.ts` for table rendering
- Call from `server.ts` after tools registration
- Gather source info from `ConnectorManager`, tool names from tool registration
