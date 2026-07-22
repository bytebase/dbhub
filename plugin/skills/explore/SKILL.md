---
description: Explore a database schema token-efficiently via the DBHub tools; use before writing SQL against a schema you haven't seen.
---

# DBHub Schema Exploration

Use `search_objects` with progressive disclosure — always coarse to fine:

1. **Orient:** `object_type: "table"`, `detail_level: "names"` (pattern defaults to `%`, matching all). Cheap even on large schemas.
2. **Narrow:** `detail_level: "summary"` for the tables that matter (row/column counts, comments), using a pattern like `%order%` rather than listing everything.
3. **Drill in:** `detail_level: "full"` only for the tables you will actually query (complete columns, types, keys) — never as a first, pattern-less call on an unfamiliar schema.

Searching `object_type: "column"` with a pattern like `%email%` is the fastest way to find which tables hold a concept.

## Querying

- Always add `LIMIT` (or `TOP` on SQL Server) when sampling data — start with `LIMIT 10`. Prefer aggregates (`COUNT`, `GROUP BY`) over pulling rows to characterize data.
- Check a table's `full` detail before writing JOINs so you use real column names — don't guess and retry.
- This plugin is read-only; if a write is rejected, tell the user rather than trying to work around it.
