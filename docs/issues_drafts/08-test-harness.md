# Test harness for plugins

## Prerequisite

Issue #3 — Architecture decisions (file `docs/issues_drafts/00-architecture-decisions.md`) must be merged. This issue runs in parallel
with #3 but lands **before #4** so the first plugin implementation lands into a
working test runner.

## Goal

Establish a minimal, consistent, polyglot testing setup for declaration, scope,
parser, and script contracts.

This issue fixes the initial tooling choice:

- TypeScript plugin and `_shared` code uses a single root `package.json` with
  npm workspaces and Vitest.
- PowerShell scripts use Pester.
- `scripts/test-all.ps1` is the single entry point that runs both tracks.

## Binding surface

Per-plugin test directories, root npm workspace metadata, Pester tests for
PowerShell scripts, and a root-level test runner. No AO runtime involvement.

## Files in scope

- `package.json` (new) — root npm workspace and test scripts
- `vitest.config.ts` (new) — shared Vitest config for TypeScript tests
- `tsconfig.base.json` (new) — shared TypeScript compiler options
- `tests/README.md` (new) — test organization and invocation
- `scripts/test-all.ps1` (new) — discovers and runs TypeScript and PowerShell tests
- `tests/powershell/` (new) — Pester tests for repo scripts
- `plugins/_shared/package.json` (new) — initial workspace package skeleton
- `plugins/_shared/tests/` (new) — initial contract tests so the runner has a target before #4 lands
- `.github/workflows/scope-guard.yml` — add a `tests` job that calls `scripts/test-all.ps1`
- `docs/issues_drafts/08-test-harness.md` — this spec

## Files out of scope

- AO end-to-end tests
- Plugin implementations beyond minimal test skeletons
- AO core, vendor

## Denylist

- `vendor/**`
- `packages/core/**`
- `.ao/**`

## Acceptance criteria

- Root `package.json` declares npm workspaces for `plugins/*` packages.
- TypeScript tests run through Vitest.
- PowerShell tests run through Pester.
- `scripts/test-all.ps1` runs both tracks and exits non-zero if either fails.
- CI `tests` job runs on PR and blocks merge on test failure.
- `tests/README.md` documents:
  - TypeScript + Vitest for `_shared` and plugin code;
  - Pester for PowerShell scripts;
  - how to run all tests;
  - how to run a single plugin's tests;
  - how to add tests for a new plugin or script.
- Initial tests focus on contract surfaces needed by #4–#6:
  - issue body parser examples;
  - path normalization edge cases;
  - declaration schema validation;
  - synthetic git fixture strategy for future scope-guard tests;
  - basic PowerShell runner behavior.
- AO runtime / real AO E2E is explicitly documented as out of scope.

## Upgrade-safety check

- Test runner depends only on Node, npm, PowerShell, and Pester; not on AO.
- No core / vendor changes.
- Test framework choice does not require AO YAML edits.

## Verification

- `scripts/test-all.ps1` returns exit 0 with all current tests passing.
- Intentionally broken TypeScript fixture causes the Vitest track to fail.
- Intentionally broken PowerShell fixture causes the Pester track to fail.
- `./scripts/verify.ps1` still passes.
