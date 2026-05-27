# 00 — Architecture decisions blocking #4–#9

## Status

Approved 2026-05-26. Must be implemented as written before issues #4, #5, #6,
#9 begin. Issue #11 (test harness) may proceed in parallel and should land
before #4.

## A. Source of truth for declared scope

Two-level model.

### Issue body — task constraints

Authoritative for task-level boundaries. Written by a human or planner in the
GitHub Issue body using fenced blocks:

- `denylist` (**mandatory**, fenced as ` ```denylist `): list of relative
  paths/globs that no declaration may include.
- `allowed_roots` (optional, fenced as ` ```allowed-roots `): upper bound on
  declared paths. If absent, the declaration is free to declare any
  non-denylisted path.

### Declaration snapshot — committed PR artifact

Derived runtime state, committed to the PR as an iteration-bound immutable
artifact:

- Path: `docs/declarations/{issue_number}.{iteration_id}.json`
- A new iteration produces a new file. Initial snapshot is immutable except
  for the one allowed amendment within the same iteration; after that
  amendment, the file is frozen. A second amendment within the same
  iteration is rejected. Audit chain is preserved by retaining all snapshots
  for an issue.
- Mandatory metadata fields:
  - `issue_number` (number)
  - `iteration_id` (string)
  - `iteration_id_source` (`"ao_session" | "wrapper_generated"`)
  - `supersedes` (string | null) — previous `iteration_id` in the same chain
  - `created_at` (ISO 8601)
  - `baseline` (object, see D)
  - `declared_paths` (string[]) — normalized relative paths
  - `declared_globs` (string[])
  - `amendments` (array; first-write is empty; one amendment per iteration max)

### Runtime mirror — local guard only

`.ao/declarations/` is gitignored. It mirrors the latest committed snapshot
for the local guard. It is never the source of truth.

The runtime wrapper either reads the existing mirror file or regenerates it
from the committed snapshot in `docs/declarations/`. If both are missing for
the current `iteration_id`, the wrapper must refuse to proceed and emit a
clear "no active declaration" error.

### Amendment limit

One declaration rewrite per `iteration_id`. The rewrite is applied in place
to the snapshot file and recorded in its `amendments` array with
`{ previous_active_scope_hash, new_active_scope_hash, changed: { added,
removed }, reason, actor, timestamp, applied: true }`. After this single
amendment, the snapshot is frozen for the rest of the iteration. A second
rewrite within the same iteration is rejected without modifying the
snapshot. A new iteration resets the amendment counter and produces a new
snapshot file.

### Validation formula

```
PR diff                              ⊆ declaration.declared_paths ∪ declaration.declared_globs
declaration.declared_paths           ⊆ issue.allowed_roots          (when allowed_roots present)
declaration.declared_paths ∩ issue.denylist = ∅                     (always)
declaration.declared_globs analogously enforced
```

CI (#6) reads the committed snapshot from the PR head and the linked Issue
body, then enforces all three constraints.

## B. AO iteration identity

Primary: one AO session = one iteration. `iteration_id = ao_session_id`,
`iteration_id_source = "ao_session"`.

A new `send-to-agent` reaction (after CI fail / changes-requested) starts a
new iteration and produces a new snapshot file.

Fallback: if the wrapper cannot obtain an AO session id (API gap, version
mismatch, direct CLI invocation), it generates
`iteration_id = "wrap-{utc_timestamp}-{short_uuid}"` and records
`iteration_id_source = "wrapper_generated"`. Implementations must not block on
a missing AO session id.

The amendment counter resets at each iteration boundary.

## C. Guard layers

Three layers, in execution order:

1. **Agent wrapper — primary (first defense).** Wraps the AO agent invocation
   (cursor / codex CLI). After each agent turn, diffs the working tree against
   the active declared scope and refuses to proceed on violations. Lives in
   `plugins/ao-scope-guard/` (#5).
2. **Pre-commit hook — secondary local backstop.** Blocks commits when staged
   paths violate scope. Catches anything the wrapper missed (manual edits,
   agents that bypass the wrapper). Pre-commit alone is **not** sufficient: it
   runs after `git add` and only catches staged paths, not working-tree
   mutations. Lives in `plugins/ao-scope-guard/hooks/` (#5).
3. **CI PR diff check — third backstop, server-side.** Blocks merge when the
   PR diff exceeds the committed snapshot or violates issue constraints. Lives
   in `.github/workflows/scope-guard.yml` (#6).

No single layer is sufficient. The wrapper covers working-tree state, the hook
covers index state, and CI covers PR-merge state.

## D. Baseline state

The declaration's `baseline` field:

```json
{
  "commit_sha": "abc123...",
  "worktree_dirty": false,
  "active_scope_hash": "sha256:..."
}
```

- `commit_sha` — `git rev-parse HEAD` at declaration time.
- `worktree_dirty` — true if `git status --porcelain` reports any **tracked or
  untracked source path** that is not in gitignored runtime locations
  (`.ao/**`, `node_modules/**`, `dist/**`, build/cache dirs). The check is
  gitignore-aware. Mere presence of `.ao/declarations/` does not make the
  worktree dirty.
- `active_scope_hash` — SHA-256 of the canonicalized JSON of
  `{ declared_paths, declared_globs, issue_denylist, issue_allowed_roots }`.

If `worktree_dirty` is true at declaration time, the declaration is rejected
with an explicit error. The implementer must commit or stash pending changes
first.

## E. Shared code location

`plugins/_shared/` — pack-level shared code. Not a separately publishable
monorepo package at this stage.

Contents:

- path normalization (consumed by #4, #5, #6)
- declaration schema and validators (consumed by #4, #5, #6, #9)
- issue body parser (consumed by #4, #6, #9)
- common types

The pack uses a single root `package.json` with npm workspaces for
TypeScript plugin code. The initial tooling stack is fixed by #11. Plugins
reference `_shared` through that workspace. No npm publication of `_shared`
until cross-repo reuse is needed.

## F. Review paths, finding format, and auto-fix loop

Primary Codex review path is AO's local built-in review flow. The local path
runs `codex exec review` from AO, records findings in the AO dashboard, and
feeds blocking feedback back to the worker through AO reactions such as
`changes-requested -> send-to-agent` and `ci-failed -> send-to-agent`.

GitHub Actions Codex review is an optional alternative for external PR
visibility and reusable workflow consumers. It is not a separate source of
truth for the auto-fix loop. Both review paths must use the same scope context
and finding format.

Shared review artifacts:

- `prompts/codex_review_prompt.md` — one prompt contract for local and GitHub
  Actions Codex review paths.
- `_shared/issue_parser` — reads `denylist` and optional `allowed_roots`.
- `_shared/declaration_schema` — validates committed declaration snapshots.
- Snapshot reader — selects the active `docs/declarations/{issue}.{iteration}.json`.

Structured finding format:

```json
{
  "type": "scope-violation | spec | quality | test | ci | security",
  "code": "short-stable-machine-code",
  "severity": "blocking | non-blocking",
  "path": "relative/path/or/null",
  "summary": "one-line human-readable stable summary",
  "details": "optional longer explanation",
  "suggested_fix": "optional",
  "source": "codex-local | codex-github-action | ci | human"
}
```

`code` is mandatory and provides machine identity for recurring findings, for
example `scope-violation:path-outside-declaration`, `quality:unused-var`, or
`ci:failed-lint`. `summary` is for humans and must not be used as the primary
identity.

Finding signature:

```text
signature = sha256(type + "\n" + code + "\n" + normalized_path_or_empty)
```

Path normalization for signatures uses the same `_shared/normalize` contract as
scope validation. No fuzzy text matching, embeddings, or NLP similarity is part
of the convergence contract.

Auto-fix thresholds and escalation timing live in AO reaction configuration and
ledger/report configuration. Prompt rules may describe operational behavior but
must not duplicate numeric thresholds.

## Acceptance for this issue

- This document exists at `docs/issues_drafts/00-architecture-decisions.md`.
- Drafts #4–#11 reference these decisions where relevant (see updates in this
  same change).
- No production code is written under this issue.

## Out of scope for this issue

- Implementation of any plugin.
- Edits to AO core, `vendor/agent-orchestrator/`, or
  `agent-orchestrator.yaml`.
- Test framework selection (decided in #11).
