# task-declaration contract

Runtime-neutral DD-026 / DD-027 task declaration and amendment contract.

## Purpose

Create auditable active scope before a worker edits files. The published GitHub
Issue is the live specification; the declaration is generated evidence consumed by
local guards and PR-level CI.

## Extension boundary

Supported surfaces are tracker metadata, prompt or wrapper context, workspace hooks,
and pack-owned `.orchestrator-pack/` mirror state. The plugin does not patch
`packages/core/**`, infer authority from a concrete runtime session, migrate old
private layouts, or broaden scope after work starts.

## Required metadata

A declaration records at least:

```json
{
  "task_id": "issue-1352",
  "session_id": "optional-explicit-runtime-identity",
  "chain_id": "optional-planner-reviewer-worker-chain-id",
  "baseline_ref": "git-ref-or-commit-at-declaration-time",
  "baseline_tree_hash": "hash-of-declared-baseline-state",
  "declared_files": ["relative/path.ext"],
  "declared_globs": [],
  "denylist": ["relative/blocked/path.ext"],
  "state": "declared",
  "amendments": []
}
```

`declared_files` and declared globs form the allow side. The denylist always wins.
Every path is normalized relative to repository root and must not escape through
absolute paths, drive prefixes, `..`, symlinks, or mixed separators.

The baseline is captured before the first worker edit and includes the immutable
commit and tree identity used by downstream checks.

## Amendment rule

Only one amendment is allowed per iteration. It records the prior and new active
scope hashes, changed paths or globs, denylist changes, reason, actor, and timestamp.
A second scope change requires a new iteration or explicit human escalation.

## CLI usage

`pack-declare` reads constraints from the linked GitHub Issue and writes the
committed snapshot plus a gitignored runtime mirror:

```bash
pack-declare --issue 1352 `
  --declared-paths plugins/task-declaration/lib/validate.ts `
  --declared-globs plugins/task-declaration/tests/**
```

The command:

1. reads the Issue body through the tracked GitHub transport;
2. parses the mandatory `denylist` and optional `allowed-roots` fences;
3. rejects a dirty baseline;
4. writes `docs/declarations/{issue_number}.{iteration_id}.json`;
5. mirrors it under `.orchestrator-pack/declarations/` for runtime guard reads.

Use `--amend --reason "<text>"` for the one amendment. A second amendment fails
without modifying either copy.

## Consumers

- `scope-guard` runtime enforcement;
- scope-guard PR-level CI;
- audit and reporting;
- optional `token-chain-ledger` attribution.

## Contract markers

- DD-026
- DD-027
- `declared_files`
- `denylist`
- one amendment
- baseline captured before edits
- no core patch
