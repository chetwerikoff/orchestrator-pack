# ao-task-declaration contract

DD-026/DD-027 equivalent for Composio AO without patching AO core.

## Purpose

Create auditable task declarations before an AO worker edits files. The
declaration defines the active scope that later guards can enforce.

## Extension boundary

Allowed implementation surfaces:

- tracker metadata adapter;
- agent wrapper prompt/context injection;
- workspace hook;
- AO session metadata when available;
- workspace-local `.ao/` state that is gitignored.

Disallowed:

- patches to upstream `packages/core/`;
- mandatory migration of the old `.ai-loop/` layout;
- hidden scope broadening after work starts.

## Required metadata

A task declaration must record at least:

```json
{
  "task_id": "tracker-or-ao-task-id",
  "session_id": "ao-session-id-when-known",
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

`declared_files` / `declared_globs` are the allow side of active scope.
`denylist` is always enforced, even when an allowlist exists.

## Validation rules

- Every task must contain either explicit scope (`declared_files` or
  `declared_globs`) or a denylist.
- Denylist entries must be normalized relative to repository root.
- Denylist entries must not escape the repository root through `..`, absolute
  paths, drive prefixes, symlink tricks, or mixed slash forms.
- Declared files metadata must be stable enough for the runtime guard and PR CI
  check to consume.
- Baseline hash/state must be recorded before the first worker edit.

## Amendment rule

Only one amendment is allowed per iteration.

An amendment must record:

- previous active scope hash;
- new active scope hash;
- changed files/globs/denylist entries;
- reason;
- actor/session;
- timestamp.

If more scope changes are needed, start a new iteration or escalate for human
review.

## Outputs for other contracts

This contract produces active scope for:

- `ao-scope-guard` runtime enforcement;
- `ao-scope-guard` PR-level CI validation;
- audit/reporting tools;
- optional `ao-token-chain-ledger` chain attribution.
