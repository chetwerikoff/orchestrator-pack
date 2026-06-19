# Autonomous claimed review-start path must resolve every function it calls (dependency-closure regression)

GitHub Issue: #335

## Prerequisite

- `docs/issues_drafts/103-llm-turn-review-start-claimed-gate.md` (GitHub
  [#318](https://github.com/chetwerikoff/orchestrator-pack/issues/318), **closed/merged**) —
  shipped the mechanical per-(PR,head) claim + covered-head gate for the
  autonomous LLM-orchestrator review-start turn. **This draft fixes a runtime
  dependency-closure regression introduced by that work** (commit `84d10cf`,
  2026-06-16); it re-uses #318's claim/coverage/head-ready contract unchanged and
  adds only the missing function resolution plus a non-fixture regression guard.
- `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` and the
  report-driven reconciler it governs — the **already-working** path that defines
  the checks-bundle resolver in-file, used here as the single canonical source the
  claimed-turn path must share rather than duplicate.

## Goal

Restore the autonomous LLM-orchestrator claimed review-start path so that an
orchestrator-turn `ao review run` no longer aborts before head-ready evaluation
with a "function is not recognized" error. The path currently calls a reconcile
checks-bundle resolver that lives only in the report-driven reconciler and is
never brought into the claimed-turn path's load closure; live (non-fixture)
execution therefore throws, while the test suite stays green because every test
supplies a fixture snapshot that short-circuits the resolver. The path must
resolve **every** function it invokes at runtime, and a regression test must fail
if any such function falls out of the load closure again.

```behavior-kind
action-producing
```

## Binding surface

- When the claimed review-start path runs **autonomously** (no test fixture
  snapshot), it MUST resolve every function it invokes — including the reconcile
  checks-bundle resolver — without a command-not-found / "is not recognized"
  failure, and proceed to the existing head-ready / coverage evaluation.
- The checks-bundle resolver MUST have **one canonical definition** shared by the
  report-driven reconciler and the claimed-turn path. Do not duplicate the
  function body into a second file (Mode 2 assumption-destruction: one source of
  truth, no copy that can drift).
- #318's behavior is **preserved unchanged**: the per-(PR,head) claim, the
  covered-head predicate, the head-ready gate, the pre-run re-check, and the
  side-effect fence all keep their current semantics. This draft adds dependency
  resolution and test coverage only — it does not alter the gate's decisions.
- Test coverage MUST exercise the resolver through the **non-fixture** path. The
  fixture-snapshot early-return must not remain the only thing the suite executes
  for this code, since that is exactly what masked the regression.

## Files in scope

- `scripts/lib/**` — the claimed review-start path and the shared reconcile
  helper it must source (planner decides whether to add a load of the existing
  definition or extract the resolver into a shared helper both paths load).
- `scripts/**` — the file that currently owns the canonical resolver definition,
  if the planner extracts it to a shared location.
- `scripts/*.test.ts` and/or `scripts/*.Tests.ps1` — the regression coverage.

## Files out of scope

- `docs/**`, `prompts/**`, `plugins/**`
- `agent-orchestrator.yaml`, `agent-orchestrator.yaml.example`
- `.github/workflows/**`
- `docs/declarations/**`

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
```

## Acceptance criteria

1. Invoking the claimed review-start path **without** a fixture snapshot resolves
   the checks-bundle resolver and reaches head-ready evaluation without a
   command-not-found / "is not recognized" error — proven by an automated test
   that drives the path through its non-fixture branch.
2. The checks-bundle resolver has exactly **one** definition in the repository,
   loaded by both the report-driven reconciler and the claimed-turn path; there is
   no duplicated copy of the function body.
3. A regression test **fails** if any function the claimed review-start path
   invokes is not in that path's runtime load closure (i.e. re-introducing the
   missing load breaks a test, not only live runtime). The test must not rely on a
   fixture snapshot that skips the resolver.
4. All existing #318 claimed-review tests continue to pass unchanged — the claim,
   coverage, head-ready, and side-effect-fence assertions are not weakened.

```positive-outcome
asserts: the autonomous (no-fixture) claimed review-start path resolves the checks-bundle resolver and advances to head-ready evaluation without a command-not-found error
input: realistic
```

## Upgrade-safety check

- No edits to AO core, `vendor/**`, or `packages/core/**`.
- No new repository secrets; no new operator env vars.
- No `agent-orchestrator.yaml` / reactions changes — pure `scripts/**` + tests.
- No unsupported YAML; no operator adoption step (the fix is internal to the
  review-start scripts already wired by #318).

## Verification

1. Run the project's TypeScript and test gates over `scripts/**` (the same `tsc`
   + test commands the existing claimed-review suite uses); all green.
2. The new non-fixture regression test from acceptance criterion 1/3 passes on the
   fixed tree, and **fails** when the load of the resolver is removed (demonstrate
   the guard actually binds — e.g. a temporary revert reproduces the
   "is not recognized" failure under test, not only at runtime).
3. The existing #318 claimed-review test file passes unchanged.
4. Manual smoke (operator, optional): on a PR with green required checks whose
   head is genuinely ready, an autonomous orchestrator-turn review start reaches
   the gate without the "is not recognized" abort.
