# Skip heavy CI jobs on markdown-only PRs (drafts/skills)

GitHub Issue: #155

## Status

Implemented in `.github/workflows/scope-guard.yml` via `classify-pr-changes` and
`if:` gates on `tests` and `self-architect-lint`. Required verifier and PR scope
guard remain unconditional.

## Prerequisite

`docs/issues_drafts/03-scope-guard-ci.md` (GitHub #6) — existing `scope-guard.yml`
jobs.

## Goal

A PR that changes only documentation/spec/skill/rule markdown must not run the
heavy advisory CI jobs (TypeScript type-check, Pester/Vitest contract tests,
self-architect lint). The single required check (`Verify orchestrator-pack
structure`) and the cheap scope guard still run on every PR.

## Binding surface

GitHub Action only. Classification is conservative: markdown-only only when
*every* changed path is `.md`/`.mdc` under the literal allowlist in the workflow.

### Markdown-only allowlist

- `docs/**`
- `.claude/skills/**`
- `.cursor/skills/**`
- `.cursor/rules/**`
- `AGENTS.md`
- top-level `*.md` (e.g. `README.md`, `CLAUDE.md`)

Non-markdown files under allowed trees force the full suite.

## Files in scope

- `.github/workflows/scope-guard.yml`
- `docs/issues_drafts/54-ci-path-filter-markdown-only.md` — this spec
- `docs/architecture.md` — short CI-layer note

## Acceptance criteria

- Markdown-only PR: `Run pack contract tests` and `Self-architect lint` skipped;
  `Verify orchestrator-pack structure` runs.
- Any path outside the allowlist or any non-`.md`/`.mdc` file: full suite unchanged.
- `PR scope guard` runs on every PR.
- Allowlist is literal in the workflow YAML (not inferred from labels).
