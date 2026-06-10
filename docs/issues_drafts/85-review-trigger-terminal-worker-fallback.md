# Start review for a green head whose live worker went quiescent without handing off

GitHub Issue: #261

## Prerequisite

- `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` (GitHub #163,
  closed) — the shipped state-derived review-trigger reconciler that decides
  eligibility from open-PR head vs `ao review list` coverage, and only ever
  targets a **live** worker session (`isLiveWorkerSession` /
  `NON_LIVE_WORKER_SESSION_STATUSES`). This issue extends its eligibility
  predicate; it does not replace the reconciler or change what a valid review
  target is.
- `docs/issues_drafts/67-orchestrator-review-gate-on-handoff.md` (GitHub #195,
  closed) — the handoff gate that requires a `ready_for_review` report for the
  exact head before starting the next review round, so intermediate commits of an
  **actively-working** worker are not reviewed prematurely. **This issue adds the
  missing escape hatch to that gate** for a worker that has gone quiescent without
  ever handing off.
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub #189,
  closed) — covered-head idempotency and the pre-run re-check that bounds dual-path
  TOCTOU. The fallback obeys both.
- `docs/issues_drafts/72-reconcile-ready-head-defer-subreason.md` (GitHub #212,
  closed) — gave the reconciler the enumerable `no_ready_for_review` defer
  subreason this issue acts on. No new subreason taxonomy is required; this issue
  makes one sub-case of `no_ready_for_review` eligible.
- `docs/issues_drafts/70-orchestrator-event-driven-review-trigger.md` (GitHub
  #207, closed) — the seconds-scale event-driven first run for a handed-off head,
  and the `red-defers-only` CI contract. It remains the fast path; this fallback
  is a slow backstop and reuses its CI contract unchanged.

## Goal

When a pull request's head is CI-eligible and not yet covered by any review run,
but the **live** worker that owns it has gone **quiescent** — idle, no pending
work, head unchanged across a debounce window — without ever reporting
`ready_for_review` (e.g. its CI-green handoff nudge was overwritten and lost, the
literal PR #260 / opk-37 state), the review must still start automatically
against that live worker. Today the #195 handoff gate defers such a PR forever
with `no_ready_for_review`, leaving a finished, green PR un-reviewed with no
self-healing path. The handoff gate stays fully in force while the worker is
**actively working**; this issue only adds an eligibility branch for the
**sustained-quiescence** case, where prolonged inactivity on a stable green head
is the practical equivalent of a handoff.

```behavior-kind
action-producing
```

## Binding surface

- The shipped review-trigger reconciler's eligibility decision gains one
  additional **eligible** branch: a PR whose current head is CI-eligible and
  uncovered, has no live `ready_for_review` bound to that current head, **and**
  whose owning worker session is **live but quiescent past a debounce window**,
  becomes review-eligible; a review run is started for that head **against that
  live session**.
- **The review target must be a live session (hard constraint).** `ao review run`
  refuses orphan/dead sessions (`NON_LIVE_WORKER_SESSION_STATUSES`), so this
  fallback can only fire when a live session still owns the current head. A
  genuinely not-live owner (exited/terminated/cleanup/etc.) is therefore **out of
  scope** here — its green head cannot be reviewed via `ao review run` and needs a
  separate orphan-review/sessionless mechanism (see Files out of scope). This is
  the deliberate inverse of an earlier framing: the fallback fires *because* the
  worker is still a live, addressable target, not because it is gone.
- **"Quiescent" is the safety-bearing predicate.** It means: the owning session
  is live (not in the non-live status set), is idle with no pending/unconsumed
  delivery, and its current head has been stable and CI-eligible across a debounce
  window long enough that an actively-working worker would not be misclassified.
  The exact debounce length and quiescence signals are the planner's to choose,
  bounded by the safety invariant below; tie the debounce to an existing
  staleness/heartbeat window rather than inventing a new constant where one fits.
- **Safety invariant (non-negotiable):** while the worker is actively working —
  mid-turn, has pending/unconsumed work, or changed its head within the debounce
  window — the #195 gate is unchanged: absence of `ready_for_review` still defers.
  The fallback fires only after sustained quiescence.
- **Pre-run revalidation (TOCTOU guard).** Immediately before emitting
  `ao review run`, the reconciler re-reads — from one fresh snapshot — the PR's
  current head, coverage, report binding, CI eligibility, the owning session
  identity + liveness, and the quiescence/debounce basis. It aborts the start
  (fail-closed, logged defer) if any changed since the eligibility decision: the
  worker resumed activity, a `ready_for_review` for the current head appeared, the
  head moved, the owning session changed or went not-live, or the head became
  covered. This extends the #189 pre-run re-check to the quiescence predicate.
  **Residual race (accepted):** if the worker resumes and pushes a new head
  *after* the pre-run snapshot, the review runs against the prior green head; that
  is benign — the new head is uncovered and re-evaluated on the next tick, and the
  reviewed head was green and stable. Bounding the window to the recheck is
  sufficient per the cost rule; absolute proof a live session will never resume is
  impossible and not required.
- **Fail-closed binding rule.** The fallback fires only when the reconciler can
  resolve, from authoritative orchestrator state, the single **live** session that
  owns the PR's current head. If multiple candidate sessions match, the owner
  cannot be resolved to the current head, a session-id rotation is unresolvable,
  or no live session owns the current head, it **fails closed**: no review starts
  and a defer reason is recorded (a visible defer, not a silent hang). Which AO
  field provides the authoritative ownership binding is the planner's choice.
- The fallback obeys covered-head idempotency (#189) and **reuses the existing
  report-driven path's CI eligibility contract unchanged** (#207 red-defers-only:
  red, and degraded/unknown visibility per existing handling, defer; green or
  genuinely-pending-known is eligible). It starts at most one review run per
  uncovered head (no duplicate or churn loop).
- The reconciler records a distinct, enumerable reason on the fallback start
  (distinguishable from a report-driven start and from a continued
  `no_ready_for_review` defer), so the decision is auditable from the log.
- **Operator adoption:** none beyond restarting the supervised reconciler if the
  task changes a supervised process surface; the task introduces no new operator
  env var, no `agent-orchestrator.yaml` change, and no new go-live process. State
  the actual restart step (if any) in Verification.

## Files in scope

- The shipped review-trigger reconciler **eligibility-decision modules** — in the
  current layout `docs/review-trigger-reconcile.mjs` and `docs/review-head-ready.mjs`
  (the `.mjs` files the reconciler delegates the start/defer decision to and the
  tests import directly), plus their PowerShell drivers
  (`scripts/review-trigger-reconcile.ps1`, `scripts/review-trigger-reeval.ps1`)
  and any coverage/eligibility helpers under `scripts/lib/` they call. These
  `.mjs` files are **code helpers**, not prose docs, despite living under `docs/`;
  editing the real predicate there is in scope.
- Their colocated test suites (`scripts/review-trigger-*.test.ts`,
  `scripts/review-head-ready.test.ts`, and any eligibility-helper tests).
- Prose documentation of the review trigger paths only where it already describes
  the handoff gate (e.g. the review-paths section the reconciler is documented in).

## Files out of scope

- **Reviewing a genuinely not-live worker's head.** A head owned only by an
  exited/terminated/orphaned session cannot be reviewed via `ao review run` (it
  refuses non-live sessions). A sessionless/orphan-review or session-adoption
  mechanism is a separate, harder task — do not invent one here; this fallback
  fails closed for that case.
- The worker→orchestrator message channel and `#216` submit reconciler. Making
  that channel loss-free (auto-resend of an overwritten nudge) is a separate
  reliability lever; this issue makes a lost nudge **non-fatal** to review by
  starting on sustained quiescence instead. Do not change send/mailbox semantics.
- Worker-liveness/death **detection** mechanics. This issue *consumes* the
  liveness and PR↔head ownership signals orchestrator state already exposes; it
  builds no new probe, and fails closed where the signal is absent or ambiguous.
- The active-but-genuinely-stuck worker that keeps signalling activity yet never
  hands off. That is a worker-stuck-detection class (distinct from quiescence);
  left as an explicit open question (see Verification).
- `agent-orchestrator.yaml`, reactions, notifiers, and any AO-core/vendor code.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

Observable, each provable by a fixture-driven test against representative
orchestrator state (`ao status` / `ao review list` / `gh pr view` / `gh pr list`
shapes). The
enumeration below is the decision's full equivalence-class matrix; each row is a
fixture.

Decision: *start a review run for (PR, current head)?* Dimensions — CI
eligibility {eligible (green / pending-known) | defer (red / degraded / unknown)}
× head covered {yes | no} × live `ready_for_review` for current head {present |
absent} × owning-session state {active | live-quiescent-past-debounce |
live-quiescent-within-debounce | not-live/orphan | ambiguous/unresolvable owner}.

1. **CI-eligible · uncovered · report absent · live owner quiescent past
   debounce** → **starts** a review run for the current head, targeting that live
   session (the incident class: lost nudge / idle-no-report). This is the new
   behavior, and the PR #260 / opk-37 case.
2. **CI-eligible · uncovered · report absent · owner actively working** →
   **defers** with `no_ready_for_review` (unchanged #195 gate — never review an
   active worker's intermediate head).
3. **CI-eligible · uncovered · report absent · live owner idle but within the
   debounce window (not yet sustained)** → **defers** (quiescence not yet
   established); becomes row 1 once the debounce elapses with the head still
   stable.
3a. **CI-eligible · uncovered · report absent · live owner idle and stable past
    debounce BUT with a pending/unconsumed delivery** → **defers**. A queued
    message the worker has not yet consumed (e.g. a re-sent or overwritten
    handoff nudge sitting in its mailbox) means the worker has not processed its
    latest input; starting now would review ahead of work it is about to do,
    recreating the handoff race. Quiescence requires **no pending/unconsumed
    delivery**, not merely idle + stable head.
4. **CI-eligible · uncovered · report present (bound to current head)** → starts
   via the existing report-driven path (unchanged #195/#207).
5. **CI-eligible · uncovered · report bound to a stale/older head · live owner
   quiescent past debounce** → treated as report-absent for the current head →
   **starts** (a stale-bound report is not a live handoff for the current head).
6. **covered (terminal review run already covers current head) · any** → does
   **not** start (unchanged #189 covered-head idempotency).
7. **CI defers (red / degraded / unknown) · any** → does **not** start; reuses the
   existing CI eligibility contract unchanged (#207 red-defers-only).
8. **No live session owns the current head (owner is not-live/orphan)** → **fails
   closed**, does **not** start, records a defer reason naming "no live review
   target" (out-of-scope orphan-review case; must not target a dead session).
9. **A live replacement/respawned session owns the current head** → it is the
   review target: **defers** if it is actively working (row 2), **starts** once it
   is quiescent past the debounce (row 1). An older terminal session for the same
   PR never becomes the target.
10. **Ambiguous/unresolvable owner** — multiple live candidates, or an owner that
    cannot be resolved to the current head → **fails closed**, does **not** start,
    records a defer reason.
11. **Pre-run revalidation (TOCTOU):** when state changes between the eligibility
    decision and the `ao review run` emission — worker resumed activity, a
    `ready_for_review` for the current head appeared, a pending/unconsumed
    delivery appeared for the owner, head moved, owner changed or went not-live,
    or head became covered → the start is **aborted** (fail-closed, logged); no
    review runs on the now-stale decision.
12. **Idempotency:** repeated reconciler ticks over a row-1 PR start **exactly
    one** review run for that head; subsequent ticks find it covered/in-flight and
    do not start a second.
13. The fallback start is logged with a reason distinct from a report-driven start
    and from a continued `no_ready_for_review` defer, naming the PR, head SHA, and
    the quiescence basis (including the no-pending-delivery signal); each
    fail-closed defer (rows 3a, 7–11) is logged with its distinguishing reason.

```positive-outcome
asserts: a CI-eligible, uncovered PR whose live owning worker has been idle with a stable head and no pending/unconsumed delivery past the debounce window, and has no ready_for_review for the current head, gets exactly one review run started for that head against the live session
input: external-tool-output
provenance: capture-backed
```

The `capture-backed` fixtures for criteria 1–13 must use orchestrator state
shapes captured from real `ao status` / `ao review list` / `gh pr view` (or
`gh pr list`) output
(including the live `no_ready_for_review` reconcile defer record and the live-idle
`opk-37` session row from the PR #260 incident), not hand-invented shapes. The PR
#260 fixture must show the owner **live and idle** with a stable head past the
debounce (→ row 1, starts), and a sibling fixture where the same owner is
**not-live** (→ row 8, fail-closed) to prove the live-target constraint. A
plausible-but-impossible state must not satisfy criterion 1. Rows 2, 3, 8, 9, 10,
and 11 are the safety-regression / fail-closed guards.

## Upgrade-safety check

- No edits to AO core, `vendor/**`, or `packages/core/**`.
- No new `agent-orchestrator.yaml` keys, reactions, or unsupported YAML.
- No new repository secret or operator env var.
- No change to what `ao review run` accepts as a target (live sessions only) or to
  its invocation semantics beyond adding one eligibility branch ahead of the
  existing start.
- The #195 handoff gate, #189 covered-head idempotency, and the #207 CI contract
  remain observably intact (criteria 2, 6, 7 are regression guards).

## Verification

- A test suite covering acceptance criteria 1–13, each a separate fixture row of
  the equivalence-class matrix, run as the colocated `*.test.ts` suite passes.
- Criteria 2, 3, 3a, 6, 7, 8, 9, 10, 11 explicitly assert no-regression /
  fail-closed safety: the #195 gate (2, 3), pending-unconsumed-delivery defers
  (3a), #189 idempotency (6), the #207 CI contract (7), never targeting a dead
  session (8), the live-replacement target (9), ambiguity fails closed (10), and
  the pre-run TOCTOU abort (11). A fixture with an idle live owner holding a
  pending/unconsumed delivery (from the submit-reconcile state) must defer (3a).
- A reproduction fixture built from the PR #260 incident (`no_ready_for_review`,
  `reportBoundHeadSha: none`, `ciLevel: green`, owner `opk-37` live + idle, head
  stable past the debounce) asserts criterion 1 starts the review against opk-37.
- The reconciler's own test harness demonstrates idempotency (criterion 12) across
  multiple ticks, and the pre-run revalidation (criterion 11) by mutating state
  between decision and emission in the fixture.
- State the exact supervised-process restart step (if any) needed for the change
  to take effect in the running supervisor.
- **Open questions (record before sync, not in scope):**
  (a) an *active* worker that keeps signalling activity yet never hands off is
  excluded (rows 2/3 defer it) — detecting/escalating that is a separate
  worker-stuck task; (b) reviewing a genuinely not-live worker's green head (row 8
  fails closed) needs a sessionless/orphan-review mechanism AO does not expose
  today — a separate task. Note both so the planner does not widen this fallback to
  cover them.

