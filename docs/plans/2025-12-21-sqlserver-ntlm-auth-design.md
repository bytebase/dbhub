# SQL Server NTLM Authentication

Issue: https://github.com/bytebase/dbhub/issues/105

## Overview

Add NTLM authentication support for SQL Server connections. This enables users to authenticate using Windows domain credentials when SQL Server authentication is disabled by policy.

## Configuration

DSN format only (TOML individual parameters deferred to follow-up PR):

```
sqlserver://user:password@host:1433/database?authentication=ntlm&domain=MYDOMAIN
```

Examples:
```
# NTLM with domain
sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?authentication=ntlm&domain=CORP

# NTLM with SSL
sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?authentication=ntlm&domain=CORP&sslmode=require

# NTLM with named instance
sqlserver://jsmith:secret@sqlserver.corp.local:1433/app_db?authentication=ntlm&domain=CORP&instanceName=PROD
```

## Validation

- `authentication=ntlm` without `domain` → error: "NTLM authentication requires 'domain' parameter"
- `domain` without `authentication=ntlm` → error: "Parameter 'domain' requires 'authentication=ntlm'"

## Implementation

File: `src/connectors/sqlserver/index.ts`

Changes to `SQLServerDSNParser.parse()`:

1. Extract `domain` from query parameters
2. Validate NTLM parameter consistency
3. Build NTLM authentication config:

```typescript
if (options.authentication === "ntlm") {
  config.authentication = {
    type: "ntlm",
    options: {
      domain: options.domain,
      userName: url.username,
      password: url.password,
    },
  };
}
```

Note: Top-level `user`/`password` are automatically overridden by the `authentication` object per mssql docs.

## Testing

Unit tests (`src/connectors/__tests__/sqlserver.test.ts`):

1. Valid NTLM DSN → correct `authentication` object built
2. NTLM + sslmode + instanceName combined → all options preserved
3. `authentication=ntlm` without `domain` → throws clear error
4. `domain` without `authentication=ntlm` → throws clear error

No integration tests (would require Windows domain controller).

## Documentation Updates

- `CLAUDE.md` - Add NTLM DSN example
- `dbhub.toml.example` - Add commented NTLM example

## Out of Scope

- TOML individual parameter support (follow-up PR)
- Special characters in password handling (follow-up PR)
- Trusted Connection / msnodesqlv8 (requires native dependencies)
