---
name: fix-bug
description: Use when given a GitHub issue URL or number to investigate and implement a fix. Triggers on "fix issue", "fix bug", "fix #123", GitHub issue URLs, or any request to resolve a reported problem from a GitHub issue. Also triggers when asked to investigate errors, diagnose failures, or debug unexpected behavior in DBHub.
---

# Fix Bug from GitHub Issue

Systematic workflow for turning a GitHub issue into a working fix in the DBHub codebase.

## Workflow

1. **Fetch** → 2. **Analyze** → 3. **Locate** → 4. **Reproduce** → 5. **Plan** → 6. **Implement** → 7. **Verify** → 8. **PR**

## Step 1: Fetch Issue

```bash
# From URL: https://github.com/owner/repo/issues/123
gh issue view 123 --json title,body,labels,comments,state

# From another repo
gh issue view 123 --repo owner/repo --json title,body,labels,comments,state
```

| Input | How to fetch |
|-------|-------------|
| `https://github.com/owner/repo/issues/42` | `gh issue view 42 --repo owner/repo` |
| `#42` or `42` | `gh issue view 42` (current repo) |
| `owner/repo#42` | `gh issue view 42 --repo owner/repo` |

## Step 2: Analyze Issue

Extract from the issue:
- **What's broken**: Expected vs actual behavior
- **Reproduction steps**: How to trigger the bug
- **Environment**: Database type, connection method (DSN, SSH tunnel, TOML config), transport (stdio/HTTP)
- **Labels/comments**: May reveal affected area or prior investigation
- **Linked PRs/issues**: Check for related context

## Step 3: Locate Relevant Code

Use the issue details to identify which part of the codebase is affected. DBHub has a clear modular structure — most bugs fall into one of these areas:

| Bug Category | Where to Look | Key Files |
|-------------|--------------|-----------|
| Connection failures | Connector implementations | `src/connectors/{db-type}/index.ts`, `src/connectors/manager.ts` |
| SQL execution errors | Tool handlers | `src/tools/execute-sql.ts`, `src/utils/allowed-keywords.ts` |
| Schema/table listing | Search tool | `src/tools/search-objects.ts` |
| DSN parsing issues | Parser logic | `src/connectors/{db-type}/index.ts` (DSNParser), `src/utils/dsn-obfuscate.ts`, `src/utils/safe-url.ts` |
| SSH tunnel problems | Tunnel utilities | `src/utils/ssh-tunnel.ts`, `src/utils/ssh-config-parser.ts` |
| TOML config issues | Config loading | `src/config/toml-loader.ts`, `src/types/config.ts` |
| Multi-database routing | Manager & tools | `src/connectors/manager.ts`, `src/utils/tool-handler-helpers.ts` |
| Custom tool issues | Custom handler | `src/tools/custom-tool-handler.ts`, `src/tools/registry.ts` |
| HTTP transport | Server setup | `src/server.ts` |
| Read-only violations | SQL validation | `src/utils/allowed-keywords.ts`, `src/utils/sql-parser.ts` |
| Row limiting | SQL rewriting | `src/utils/sql-row-limiter.ts` |
| API endpoint issues | API handlers | `src/api/sources.ts`, `src/api/requests.ts` |
| AWS IAM auth | Token signing | `src/utils/aws-rds-signer.ts` |

Search for error messages, function names, or file paths mentioned in the issue. Trace the code path from entry point to the failure.

## Step 4: Reproduce

**If integration tests exist for the area:**
Write a failing test that captures the bug. DBHub's test infrastructure makes this straightforward:
- Database connector bugs → extend existing integration test in `src/connectors/__tests__/`
- Utility bugs → add cases to existing unit tests in `src/utils/__tests__/`
- Tool handler bugs → add to `src/tools/__tests__/`
- Config bugs → add to `src/config/__tests__/`

Use the test fixtures in `src/__fixtures__/` for multi-database or readonly/max_rows scenarios.

**If no test infrastructure applies:**
Trace the code path and confirm the logic flaw by reading.

## Step 5: Plan the Fix

For non-trivial fixes (multi-file, architectural impact): use `EnterPlanMode`.

For simple fixes (single function, clear root cause): proceed directly.

## Step 6: Implement

- Fix the root cause, not just the symptom
- Keep changes minimal and focused
- Follow existing code conventions (see CLAUDE.md for style guide)
- Use parameterized queries for any database operations
- Validate inputs with zod schemas where appropriate

## Step 7: Verify

Run the relevant tests to confirm the fix:
```bash
pnpm test:unit                    # Quick check — no Docker needed
pnpm test src/path/to/test.ts     # Run the specific test file
pnpm test:integration             # Full integration suite if needed
```

Check that:
- The failing test (if written) now passes
- No existing tests regressed
- The diff fully addresses the issue

## Step 8: Create PR

1. **Create a branch**:
   ```bash
   git checkout -b fix/issue-123
   ```

2. **Commit changes** referencing the issue:
   ```bash
   git add <changed-files>
   git commit -m "$(cat <<'EOF'
   Fix: <short description>

   Closes #123
   EOF
   )"
   ```

3. **Push and create the PR**:
   ```bash
   git push -u origin fix/issue-123
   gh pr create --title "Fix: <short description>" --body "$(cat <<'EOF'
   ## Summary
   <What was broken and how this fixes it>

   ## Changes
   <Bullet list of changes>

   Closes #123

   ## Test plan
   - [ ] Existing tests pass
   - [ ] New test covers the bug scenario (if applicable)
   EOF
   )"
   ```

4. **Return the PR URL** to the user.

## Common Mistakes

- **Fixing symptoms instead of root cause**: Trace the full code path before patching
- **Skipping reproduction**: A fix without a repro is a guess
- **Scope creep**: Fix the reported issue, don't refactor surrounding code
- **Missing edge cases**: Check if the fix handles related scenarios mentioned in comments
- **Not testing with the right database**: If the bug is database-specific, test with that connector
