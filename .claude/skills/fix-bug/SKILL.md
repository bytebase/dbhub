---
name: fix-bug
description: Use when given a GitHub issue URL or number to investigate and implement a fix. Triggers on "fix issue", "fix bug", "fix #123", GitHub issue URLs, or any request to resolve a reported problem from a GitHub issue.
---

# Fix Bug from GitHub Issue

## Overview

Systematic workflow for turning a GitHub issue into a working fix: fetch context, reproduce, locate root cause, plan fix, implement, verify.

## Workflow

```dot
digraph fix_bug {
    rankdir=TB;
    node [shape=box];

    fetch [label="1. Fetch issue details\n(gh issue view)"];
    analyze [label="2. Analyze issue\n(symptoms, repro steps, labels)"];
    locate [label="3. Locate relevant code\n(Grep/Glob/Explore agents)"];
    reproduce [label="4. Reproduce if possible\n(write failing test or manual check)"];
    plan [label="5. Plan the fix\n(EnterPlanMode for non-trivial)"];
    implement [label="6. Implement fix"];
    verify [label="7. Verify fix\n(run tests, check repro)"];

    fetch -> analyze -> locate -> reproduce -> plan -> implement -> verify;
}
```

## Step Details

### 1. Fetch Issue

Extract issue info using `gh`:

```bash
# From URL: https://github.com/owner/repo/issues/123
gh issue view 123 --json title,body,labels,comments,state

# From another repo
gh issue view 123 --repo owner/repo --json title,body,labels,comments,state
```

If given a URL, parse the owner/repo/number from it. If given just `#123` or `123`, use the current repo.

### 2. Analyze Issue

Extract from the issue:
- **What's broken**: Expected vs actual behavior
- **Reproduction steps**: How to trigger the bug
- **Environment**: Version, OS, config if mentioned
- **Labels/comments**: May reveal affected area, priority, prior investigation
- **Linked PRs/issues**: Check for related context

### 3. Locate Relevant Code

Use the issue details to search the codebase:
- Search for error messages, function names, or file paths mentioned in the issue
- Use Explore agents for broad searches, Grep/Glob for targeted ones
- Trace the code path from entry point to the failure

### 4. Reproduce

If tests exist:
- Write a failing test that captures the bug (TDD approach)

If no test infrastructure applies:
- Identify the code path and confirm the logic flaw by reading

### 5. Plan the Fix

For non-trivial fixes (multi-file, architectural impact): use `EnterPlanMode`.

For simple fixes (single function, clear root cause): proceed directly.

### 6. Implement

- Fix the root cause, not just the symptom
- Keep changes minimal and focused
- Follow existing code conventions

### 7. Verify

- Run existing tests: ensure no regressions
- Run new test (if written in step 4): confirm it passes
- Review the diff: does it address the issue fully?

## Parsing Issue References

| Input | How to fetch |
|-------|-------------|
| `https://github.com/owner/repo/issues/42` | `gh issue view 42 --repo owner/repo` |
| `#42` or `42` | `gh issue view 42` (current repo) |
| `owner/repo#42` | `gh issue view 42 --repo owner/repo` |

## Common Mistakes

- **Fixing symptoms instead of root cause**: Trace the full code path before patching
- **Skipping reproduction**: A fix without a repro is a guess
- **Scope creep**: Fix the reported issue, don't refactor surrounding code
- **Missing edge cases**: Check if the fix handles related scenarios mentioned in comments
