# Add self-architect mechanical lint

GitHub Issue: #7

## Prerequisite

Issue #3 — Architecture decisions (file `docs/issues_drafts/00-architecture-decisions.md`) must be merged. This issue does not
depend on the declaration model but is sequenced after #4–#6 to avoid
churning lint rules while the core safety contracts settle.

## Goal

Convert `prompts/self_architect_check.md` from a prompt-only review into an
executable lint that catches paired script/template edits and duplicated prompt
literals at authoring time.

## Binding surface

Standalone PowerShell CLI plus a GitHub Actions job. Not an AO plugin.

Reason: lint runs on the pack repo and on target repos at authoring time,
before AO is involved.

## Files in scope

- `scripts/lint-self-architect.ps1` (new) — scan staged changes for paired edits + duplicate literals
- `.github/workflows/scope-guard.yml` — add a new job `self-architect-lint`
- `prompts/self_architect_check.md` — append a "Mechanical check" section that references the script
- `docs/issues_drafts/04-self-architect-lint.md` — this spec

## Files out of scope

- AO core, vendor
- Other plugin directories

## Denylist

- `vendor/**`
- `packages/core/**`
- `.ao/**`

## Acceptance criteria

- Lint is **warning-first**: default output is structured warnings with exit 0, regardless of finding count.
- `-Strict` flag (used in CI) exits 1 only on findings from the **narrow rules list**:
  - exact-duplicate prompt literals of ≥ 10 consecutive lines across two or more files;
  - paired script/template edits where both files contain a shared literal block of ≥ 8 lines that diverged in this PR.
- Heuristic rules (similarity scoring, short literals, near-duplicates) emit warnings but never trip `-Strict`.
- Each finding includes file paths, line ranges, and a one-line rationale.
- Rule set is configurable via `scripts/lint-self-architect.config.json` (paths, thresholds); ships with defaults matching the narrow list above.
- README/prompt updated with usage, `-Strict` rule list, and how to add suppressions for justified duplicates.

## Upgrade-safety check

- Script depends only on git, not on AO.
- No AO YAML, `vendor/`, or `packages/core/` touched.

## Verification

- Unit-test fixtures: one paired-edit case, one duplicate-literal case, one negative case.
- CI job blocks PR when fixtures are present in the diff.
- `./scripts/verify.ps1` still passes.
