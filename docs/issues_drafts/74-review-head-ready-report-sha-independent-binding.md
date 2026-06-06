# Head-ready review trigger must not depend on a head SHA the AO report never stores

GitHub Issue: #218

## Prerequisite

- `docs/issues_drafts/67-orchestrator-review-gate-on-handoff.md` (GitHub #195) — established the
  "ready_for_review for the exact head SHA + CI contract" head-ready gate this issue repairs.
- `docs/issues_drafts/72-reconcile-ready-head-defer-subreason.md` (GitHub #212) — added the
  enumerable defer subreasons and explicitly punted the predicate-evaluation bug to "a separate
  #195 issue." **This is that issue.**
- Context only (no merge dependency): `docs/issues_drafts/58-safe-review-trigger-reconciliation.md`
  (#163), `docs/issues_drafts/66-orchestrator-ci-green-wake-worker.md` (#191),
  `docs/issues_drafts/70-orchestrator-event-driven-review-trigger.md` (#207) — the automated
  trigger paths that share the broken binding.

## Goal

Make the automated review-trigger paths actually fire when a worker is genuinely ready for review
on green CI, using only state that AO 0.9.x and GitHub actually expose. Today every state-derived
trigger path defers indefinitely on a real ready-for-review PR, so AO-local review only ever starts
when the LLM orchestrator turn happens to fire — late or not at all. This is the root cause of the
recurring "review doesn't auto-start after the worker finishes" incidents.

## Binding surface

- The head-ready predicate that gates review triggers MUST determine whether the current PR head is
  covered by a `ready_for_review` hand-off **without relying on a head-SHA value stored inside the
  AO report record**. AO 0.9.x `ao report` exposes only `--note`, `--pr-url`, `--pr-number` — it
  records no commit/head SHA on the report, so any binding that requires a report-stored SHA can
  never match and the predicate is structurally unsatisfiable.
- Report→head coverage MUST instead be derived from observable AO/GitHub state. The hand-off
  contract from #195/#186 (a `ready_for_review` authorizes review for the head that was current
  when the worker reported it, and a later commit supersedes it) MUST be preserved — an older
  `ready_for_review` must not authorize review of a newer head that landed after it.
- The repaired predicate MUST be the single shared evaluation used by all automated trigger paths
  (the periodic reconcile, the CI-green wake path, the event-driven wake path, and the
  orchestrator-loop advisory helper). No path may keep a private SHA-from-report binding.
- The structured defer subreasons from #212 (`head_covered`, `failed_or_cancelled_on_head`,
  required-CI red/missing/not-yet, degraded-CI hand-off) MUST remain distinguishable; only the
  spurious "not ready" classification of genuinely-ready SHA-less reports is corrected.

## Files in scope

- The review head-ready predicate helpers and their consumers under `docs/` (the `*.mjs` review
  trigger/reconcile/orchestrator-loop helpers that evaluate head-readiness).
- The reconcile/trigger tests and fixtures under `scripts/` (`*.test.ts` and their JSON fixtures).
- Type declaration siblings (`docs/*.d.mts`) and the declaration snapshot under `docs/declarations/`
  if the implementation changes exported shapes.

## Files out of scope

- `agent-orchestrator.yaml.example` and `orchestratorRules` prose — the contract wording for #195
  is unchanged; this issue repairs the mechanical predicate only. Touch only if a reviewer shows
  the prose asserts a report-stored SHA.
- `packages/core/**`, `vendor/**`, AO CLI behavior. The fix lives entirely in pack code; do not
  attempt to make AO store a head SHA on reports.
- The review delivery/send paths (#171/#202) and worker-lifecycle logic.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. On a session whose latest accepted `ready_for_review` report carries **no** head-SHA field
   (the real AO 0.9.x shape: `reportState`, `prNumber`, `accepted`, timestamps — nothing else),
   with required CI green and the current head uncovered, the head-ready predicate classifies the
   head as **eligible** and the reconcile starts exactly one review run (`started == 1`).
2. The live repro — PR #217 / session `opk-19`, head `8e35c00…`, the two accepted SHA-less
   `ready_for_review` reports at 06:08 and 06:10 — is captured as a regression fixture that fails
   under the old binding and passes under the new one.
3. Supersession is preserved: a `ready_for_review` report that predates the current head commit
   (a newer commit landed after the report) does **not** authorize a review run for the new head;
   that head defers until a hand-off for it exists.
4. The existing #212 defer subreasons still fire for their real cases: `head_covered` on a covered
   terminal/in-flight run, `failed_or_cancelled_on_head` on a failed/cancelled run for the head,
   required-CI red/missing deferral, and degraded-CI hand-off routing — none regress to a false
   "ready."
5. All automated trigger paths (periodic reconcile, CI-green wake, event-driven wake, and the
   orchestrator-loop advisory helper) evaluate head-readiness through the same repaired predicate;
   a test or assertion demonstrates none retains a report-stored-SHA binding.
6. No code path reads a head SHA from `report.headRefOid` / `report.forHeadSha` /
   `report.prHeadSha` (or snake_case variants) as the sole basis for report→head coverage.

## Upgrade-safety check

- No edits to `packages/core/**` or `vendor/**`; no change to AO CLI flags or expectations.
- No new unsupported `agent-orchestrator.yaml` fields and no new repo secrets.
- Declaration snapshot regenerated via the normal `ao-declare` flow if exports change — not
  hand-edited.
- The fix must work against the AO 0.9.x report shape as installed (no head SHA on reports); it
  must not assume an AO version that records a report head SHA.

## Verification

- Unit/integration: the reconcile test suite (`scripts/review-trigger-reconcile.test.ts` and the
  ci-green/orchestrator-loop test siblings) covers criteria 1–5, including the new SHA-less
  ready-report happy-path fixture (criterion 1/2) and the supersession fixture (criterion 3).
- Dry-run proof: `pwsh -NoProfile -File scripts/review-trigger-reconcile.ps1 -Once -DryRun` against
  a fixture/snapshot equivalent to PR #217's state reports the head as ready and plans one review
  run (not `uncovered_not_ready` / `no_ready_for_review`).
- A grep/test guard demonstrates criterion 6 (no sole reliance on a report-stored head SHA field).
- `pwsh -NoProfile -File scripts/orchestrator-diagnose.ps1 -Strict` (or the staged-only equivalent
  used in CI) passes on the change.
