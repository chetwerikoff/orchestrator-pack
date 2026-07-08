# Script-owned review pipeline (documentation)

**Orchestrator LLM role vs script-owned review.** Script-owned starters below are
**not** LLM turn checklists. The LLM orchestrator does **not** start or drive routine
review rounds (exception: issue #641).

Starters: `scripts/review-trigger-reconcile.ps1`,
`scripts/review-trigger-reeval.ps1`, `scripts/orchestrator-wake-listener.ps1`.
Predicates: `docs/review-orchestrator-loop.mjs`, `docs/review-head-ready.mjs`,
`docs/review-reconcile-primitives.mjs`. Manual operator `ao-review run` stays
outside automated claim. **Script-owned procedure** — do not re-derive inline.

## Event-driven review trigger

On `merge.ready`, `scripts/orchestrator-wake-listener.ps1` applies #195/#189,
claim #267, then may `ao-review run` — never `ao spawn`, `--claim-pr`, `ao session kill`, `ao send`, or merge. This is the **event-driven review trigger** path.

## Deferred-head review re-evaluation

`scripts/review-trigger-reeval.ps1` watches deferred heads; **review run only**.
Zero-signal heads: backstop via `review-trigger-reconcile.ps1`.

## Review finding delivery

AO 0.10 auto-delivers on submit. Report `addressing_reviews` when
`deliveredFindingCount > 0`. Confirm via `scripts/review-finding-delivery-confirm.ps1`.

## Review-status reader contract

Pack scripts read session/report state via `Get-AoStatusSessionsWithReports` (and
`Get-AoStatusSessionsWithReportsIncludingTerminated` where terminated rows matter)
from `scripts/lib/Invoke-AoCliJson.ps1` — not ad-hoc `ao status --reports full`
shelling. `report-full` availability is gated by `Test-AoReportFullCliAvailable`.

## Report-state review-start seed

`scripts/review-ready-report-state-seed.ps1` polls report state, seeds #235 watches,
may start review with `startReason=report_state_seed` when handoff wake is absent.

## Autonomous dead-worker respawn

Background reconcilers may recover a **dead worker already assigned unfinished work**
via `invoke-worker-recovery.ps1` when gates pass — **never** plan new work from the
queue. Default-OFF: `docs/autonomous-respawn-policy.json`
(`allowReconcileDeadWorkerRespawn`). Operator kill suppresses respawn. Entrypoint:
`scripts/dead-worker-reconcile.ps1`.

## CI-green orchestrator nudge

`scripts/ci-green-wake-reconcile.ps1` (~1 min) may `ao send` when required CI is
green and worker is pre-hand-off idle. AO 0.9.x has no CI-green reaction. Does not
recover dead sessions.

## Orchestrator review-run coverage

**Issue #189.** Before automated `ao-review run`, starters apply covered-head
predicate via `Get-AoReviewRuns` fan-out. A head is **covered** with **same PR
linkage** (`prNumber`) and **exact normalized head SHA** (`targetSha`) when
in-flight or covered terminal (`up_to_date` / `changes_requested`). Different PR
or SHA does **not** count. `failed` / `cancelled` on current head: read failure
detail, retry once, escalate (EMPTY REVIEW TRAP).

**PRE-RUN COVERAGE RE-CHECK:** after claim, re-read `Get-AoReviewRuns` and
re-apply predicate. **prNumber-less** runs: terminal when linked session's PR is
merged; ambiguous metadata → **fail closed to** inaction.

Claim (#267): shared machine-local claim per `(prNumber, normalized targetSha)`
before `ao-review run`; held until covering run visible or terminal outcome.

## Head ready for review

**Issue #195.** Starters apply one shared predicate from `docs/review-head-ready.mjs`.
LLM orchestrator turns do **not** apply this gate for routine rounds.

Ready when ALL hold on one snapshot: latest accepted `ready_for_review` for **exact
current head SHA**; required CI green or genuinely pending (not red/missing);
head not covered per #189; no `failed`/`cancelled` awaiting EMPTY REVIEW TRAP.
**Uncovered-but-not-ready** heads: no review run, no worker-lifecycle action.
**PRE-RUN HEAD-READY RE-CHECK** widens #189: re-read head, report, CI, coverage
before `ao-review run`. **Merged PR — prNumber-less runs:** resolve via
`linkedSessionId`; fail closed to inaction when ambiguous.
