# Implement scope-guard CI step (PR diff validator)

## Status

Implemented in `.github/workflows/scope-guard.yml` via `scripts/pr-scope-check.ps1`
and `scripts/pr-scope-check.ts` (PR `pull_request` events on `windows-latest`).

## Prerequisite

Issue #3 — Architecture decisions (file `docs/issues_drafts/00-architecture-decisions.md`) must be merged. This issue implements
guard layer 3 from #3.C and enforces the validation formula from #3.A on the
server side.

This issue also depends on #4 landing the `_shared` parser/schema/normalization
outputs consumed by CI:

- `_shared/issue_parser`
- `_shared/normalize`
- `_shared/declaration_schema`

Do not start #6 until those #4 outputs are available. If parallelization is
needed later, split `_shared` bootstrap into its own issue first.

## Goal

DD-024 third backstop (per #3.C): PR-level CI that blocks merge when the PR
diff exceeds the committed snapshot or violates the linked issue's denylist
and allowed_roots. Replaces the TODO `Write-Host` in
`.github/workflows/scope-guard.yml`.

## Binding surface

GitHub Action only. No AO involvement.

Reason: PR enforcement is server-side and runs after AO has produced the PR.
This is audit/enforcement, never first defense.

## Files in scope

- `.github/workflows/scope-guard.yml` — replace TODO step with a real diff check
- `scripts/pr-scope-check.ps1` (new) — read declaration, compute PR diff, compare, report
- `docs/architecture.md` — short note that the CI step is now active
- `docs/issues_drafts/03-scope-guard-ci.md` — this spec

## Files out of scope

- Runtime guard logic (lives in `plugins/ao-scope-guard/`, see #5)
- Codex review scope context (see #9)
- AO core, vendor

## Denylist

- `vendor/**`
- `packages/core/**`
- `.ao/**`

## Acceptance criteria

- Workflow extracts linked issue number from PR body (`Closes #N` / `Fixes #N`).
- Reads issue body via `gh issue view <n> --json body` and parses `denylist` and optional `allowed_roots` per #3.A using `_shared/issue_parser`.
- Reads the committed declaration snapshot at `docs/declarations/{issue_number}.{iteration_id}.json` from the PR head. Snapshot selection for the issue:
  1. List all files matching `docs/declarations/{issue_number}.*.json`.
  2. Sort by filename, treating the `{iteration_id}` segment as the primary ordering key (lexicographic for `wrap-{ts}-{uuid}` fallbacks; AO session ids are opaque strings but stable per chain).
  3. Take the file whose `iteration_id` is the latest in the chain (resolved via the `supersedes` field forming a linked list back to the first iteration).
  4. Validate against `created_at`: if file order disagrees with `created_at` order, fail the job with an explicit "snapshot chain inconsistency" message. `created_at` is a validation field, not the primary key.
- Computes PR diff via `gh pr diff --name-only`.
- Enforces all three constraints from #3.A:
  1. `pr_diff_paths ⊆ snapshot.declared_paths ∪ snapshot.declared_globs`
  2. `snapshot.declared_paths ⊆ issue.allowed_roots` (when `allowed_roots` present)
  3. `snapshot.declared_paths ∩ issue.denylist = ∅`
- Posts a violation comment on the PR and fails the job on any violation.
- Fails the job (not no-op) when no linked issue is found in a PR body — closed-by-issue link is mandatory for scope-protected merges; failure message explains how to add `Closes #N`.
- **Fork PR policy — fail-closed by default:**
  - When the PR is from a fork (`github.event.pull_request.head.repo.fork == true`) and the issue body cannot be read with the workflow's permissions, the job fails by default with an explanatory comment.
  - Degraded mode is opt-in only: a maintainer with `write` (or higher) access on the base repo applies the label `scope-guard-degraded` to the PR. The workflow re-runs, verifies that the label was applied by a user with `write+` access via `gh api`, and then runs a **snapshot-only** check (PR diff ⊆ snapshot.declared, control-artifact exclusions still apply). The denylist / allowed_roots constraints are flagged as "unverified" in the review comment.
  - Drive-by labelers without write access do not enable degraded mode; the verification step rejects the label.
- **Control-artifact exclusion mirrors #5:** `docs/declarations/**` and `.ao/**` are excluded from the PR-diff check.
- Compatible with existing `verify-pack` job in the same workflow.

## Upgrade-safety check

- Workflow makes no assumption about a specific AO version.
- No changes to `vendor/`, `packages/core/`, or the AO YAML schema.
- Script depends only on git and gh CLI.

## Verification

- Synthetic feature branch with both in-scope and out-of-scope changes.
- CI fails on out-of-scope, passes on in-scope.
- Workflow runs on `windows-latest` (already the runner for `verify-pack`); document if a Linux job is added later.
