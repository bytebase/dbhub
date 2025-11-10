# DBHub Documentation

This documentation is built with [Mintlify](https://mintlify.com), following the same style and structure as pgschema.

## What's Been Created

### Core Documentation (Complete)

1. **index.mdx** - Introduction page with overview, features, and getting started cards
2. **installation.mdx** - Installation guide with Docker, NPM, and verification steps
3. **quickstart.mdx** - Step-by-step guide to get DBHub running with Claude Desktop
4. **coding-agent.mdx** - Guide for integrating with AI coding agents (CLAUDE.md, AGENTS.md)

### Configuration (Complete)

5. **config/dsn.mdx** - Complete DSN format reference for all databases
6. **config/multi-database.mdx** - TOML-based multi-database configuration guide

### Integrations (Partial)

7. **integrations/claude-desktop.mdx** - Complete Claude Desktop integration guide

**Still Needed:**
- `integrations/claude-code.mdx`
- `integrations/cursor.mdx`
- `integrations/vscode.mdx`

### Additional Pages Needed

**Configuration:**
- `config/environment.mdx` - Environment variable reference
- `config/ssl.mdx` - SSL/TLS configuration details

**Features:**
- `features/ssh-tunnel.mdx` - SSH tunneling guide
- `features/readonly-mode.mdx` - Read-only mode documentation
- `features/row-limiting.mdx` - Row limiting feature
- `features/multi-instance.mdx` - Multi-instance setup

**Database Support:**
- `databases/overview.mdx` - Database support matrix
- `databases/postgresql.mdx` - PostgreSQL-specific features
- `databases/mysql.mdx` - MySQL-specific features
- `databases/mariadb.mdx` - MariaDB-specific features
- `databases/sqlserver.mdx` - SQL Server-specific features
- `databases/sqlite.mdx` - SQLite-specific features

**MCP Reference:**
- `mcp/resources/schemas.mdx` - Resource: db://schemas
- `mcp/resources/tables.mdx` - Resource: db://schemas/{schema}/tables
- `mcp/resources/indexes.mdx` - Resource: indexes in tables
- `mcp/resources/procedures.mdx` - Resource: stored procedures
- `mcp/tools/execute-sql.mdx` - Tool: execute_sql
- `mcp/prompts/generate-sql.mdx` - Prompt: generate_sql
- `mcp/prompts/explain-db.mdx` - Prompt: explain_db

## Documentation Structure

```
docs/
├── docs.json                   # Mintlify configuration
├── index.mdx                   # Homepage
├── installation.mdx            # Installation guide
├── quickstart.mdx              # Quick start guide
├── coding-agent.mdx            # AI agent integration
├── config/                     # Configuration guides
│   ├── dsn.mdx                # DSN format reference
│   ├── multi-database.mdx     # Multi-DB TOML config
│   ├── environment.mdx        # [TODO]
│   └── ssl.mdx                # [TODO]
├── integrations/              # MCP client integrations
│   ├── claude-desktop.mdx     # Claude Desktop setup
│   ├── claude-code.mdx        # [TODO]
│   ├── cursor.mdx             # [TODO]
│   └── vscode.mdx             # [TODO]
├── features/                  # Advanced features
│   ├── ssh-tunnel.mdx         # [TODO]
│   ├── readonly-mode.mdx      # [TODO]
│   ├── row-limiting.mdx       # [TODO]
│   └── multi-instance.mdx     # [TODO]
├── databases/                 # Database-specific docs
│   ├── overview.mdx           # [TODO]
│   ├── postgresql.mdx         # [TODO]
│   ├── mysql.mdx              # [TODO]
│   ├── mariadb.mdx            # [TODO]
│   ├── sqlserver.mdx          # [TODO]
│   └── sqlite.mdx             # [TODO]
└── mcp/                       # MCP protocol reference
    ├── resources/
    │   ├── schemas.mdx        # [TODO]
    │   ├── tables.mdx         # [TODO]
    │   ├── indexes.mdx        # [TODO]
    │   └── procedures.mdx     # [TODO]
    ├── tools/
    │   └── execute-sql.mdx    # [TODO]
    └── prompts/
        ├── generate-sql.mdx   # [TODO]
        └── explain-db.mdx     # [TODO]
```

## Development

Install the [Mintlify CLI](https://www.npmjs.com/package/mint) to preview documentation locally:

```bash
npm i -g mint
```

Run the following command at the root of your documentation (where `docs.json` is located):

```bash
cd docs
mint dev
```

View your local preview at `http://localhost:3000`.

## Style Guide

The documentation follows pgschema's style:

- **Frontmatter**: Every page has title and description
- **Components**: Uses Mintlify components (Card, CardGroup, Tabs, Note, Warning, Tip, Accordion)
- **Code blocks**: Includes language hints and file names where appropriate
- **Examples**: Practical, real-world examples with multiple options
- **Navigation**: Logical grouping with clear hierarchy
- **Troubleshooting**: Dedicated troubleshooting sections on relevant pages

## Key Features Demonstrated

1. **Tabs** - For showing multiple installation/configuration options
2. **Cards** - For linking to related pages and next steps
3. **Accordions** - For collapsible content sections
4. **Notes/Warnings/Tips** - For highlighting important information
5. **Code blocks with titles** - For better context

## Next Steps

To complete the documentation:

1. Create the remaining integration pages (claude-code, cursor, vscode)
2. Add feature documentation (ssh-tunnel, readonly-mode, etc.)
3. Create database-specific pages
4. Write MCP reference documentation
5. Add any missing configuration pages
6. Consider adding a FAQ page
7. Add troubleshooting guide
8. Include example projects/tutorials

## Deployment

Once complete, deploy to:
- Mintlify hosting
- Custom domain: https://docs.dbhub.ai (or similar)
- Keep in sync with main README.md for consistency
