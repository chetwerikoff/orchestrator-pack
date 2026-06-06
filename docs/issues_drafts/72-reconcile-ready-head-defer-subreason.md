# Review-trigger reconcile must start a ready head on its own tick and log a structured defer subreason

GitHub Issue: #212

## Prerequisite

- `docs/issues_drafts/67-orchestrator-review-gate-on-handoff.md` (GitHub #195,
  merged) — defines the shared **"head ready for review"** predicate and the
  `uncovered-but-not-ready` defer state this draft makes observable and
  liveness-bounded. This draft is **additive**: #195 says *when* to defer; it
  never required the defer decision to record *which* sub-condition failed, nor
  that a head which has just become ready fire on the reconciler's own tick
  rather than on an orchestrator turn.
- `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` (GitHub #163,
  merged) — the state-derived reconciler whose liveness invariant ("converge
  even when the LLM-orchestrator is stuck / idle") this draft enforces for the
  specific *uncovered-but-not-ready → ready* transition. Reused, not re-specified.
- `docs/issues_drafts/70-orchestrator-event-driven-review-trigger.md` (GitHub
  #207, merged) — the event-driven fast path. In the observed incident it
  correctly deferred (`uncovered_not_ready`) because at wake time the head was
  not yet ready; this draft does not change that fast path's gating, only what a
  defer must record and how the reconciler backstop must converge afterwards.

## Background (5 Whys — failure response)

Observed (PR #211, 2026-06-06): a ready head waited ~10 min for review. Timeline
from local artifacts:

- `01:40:07` head `1607071` pushed; `01:44:07` last required CI check went green.
- `01:44:26` event-driven fast path deferred: `review-wake-trigger: defer PR #211
  (uncovered_not_ready)` — correct, the worker had not yet handed off.
- `01:45` worker report `ready_for_review` accepted for the head.
- `01:48:20` reconciler tick **still** logged `skip PR #211: uncovered_not_ready`
  — by this point CI was green and `ready_for_review` was accepted.
- `01:54:02` an orchestrator heartbeat fired; `01:54:31` the review run was
  finally created (it later came back `clean`).

5 Whys:

1. Why did review wait until `01:54`? The `01:48` reconciler tick classified the
   head as `uncovered-but-not-ready` and started nothing; only the heartbeat /
   orchestrator turn started it.
2. Why did the `01:48` tick defer a head that met all four #195
   head-ready conditions (ready_for_review for the exact head, CI not red,
   uncovered, no failed/cancelled run)? **Unknown from the artifacts** — the log
   records only the collapsed verdict `uncovered_not_ready`, not which
   sub-condition the reconciler evaluated as false in its snapshot.
3. Why is it unknown? The #195 predicate is multi-condition (report-head binding,
   CI state, coverage, failed/cancelled branch), but neither #195 nor #163
   required the reconciler to emit the failing sub-condition and the observed
   values behind a defer. The artifact is undiagnosable by construction.
4. Why did the heartbeat, not the reconciler's own next tick, start the run? The
   reconciler's liveness invariant (#163: converge without the orchestrator
   taking a turn) is not asserted for the *became-ready-after-an-earlier-defer*
   transition — nothing guarantees the next reconcile tick re-evaluates and fires
   independently of an orchestrator turn.
5. **Root cause:** the shared head-ready predicate is a black box at the
   reconciler boundary. A defer is unexplained (no subreason), and a transition
   to ready is not guaranteed to be picked up by the reconciler's own cadence —
   so a genuinely-ready head can sit deferred until an unrelated heartbeat
   happens to wake the orchestrator.

## Goal

Make the reconciler's review-trigger decision **self-explaining and
self-converging** at its own cadence. A defer of an uncovered head must record
*which* head-ready sub-condition was not satisfied and the values it observed, so
any deferral is diagnosable from the artifact alone. And once a head satisfies the
#195 head-ready predicate, the reconciler's **own next tick** must start the
review run — convergence must not depend on an orchestrator heartbeat or LLM turn.
This closes the observability gap behind the PR #211 incident and removes the
heartbeat dependency that turned a ~3-minute wait into a ~10-minute one, without
re-specifying the predicate (#195), the coverage rule (#189), or the reconciler's
safety invariants (#163/#97).

## Binding surface

This issue commits the repository to the following contracts. It changes only
what the reconciler **records** about a trigger decision and **when** it acts on a
ready head — not the predicate itself, not any worker-lifecycle behaviour.

- **Structured defer subreason (observability).** When the reconciler declines to
  start a review run for a PR head because the head is **uncovered but not ready**
  (the #195 predicate judged it not-ready), the decision it emits MUST identify
  *which* head-ready sub-condition was evaluated as not satisfied, drawn from a
  documented, enumerable set covering at least: the report-to-current-head binding
  (no accepted `ready_for_review` for the exact current head SHA / report bound to
  an older SHA), required-CI state (red/failing vs missing/unknown/unresolvable vs
  not-yet-observed), and the failed/cancelled-on-current-head branch. A single
  opaque `uncovered_not_ready` token for all of these causes is the defect this
  issue removes. (A head that the reconciler skips because it is **already
  covered** per #189 is a *distinct* no-start class, not an uncovered-not-ready
  subreason — it is already emitted as its own decision, e.g. `head_covered`, and
  MUST stay distinguishable from every not-ready subreason; this issue does not
  change #189 covered-skip behaviour.)
- **Hand-off route is recorded — degraded-CI escalation is not generic
  not-ready.** #195 routes two not-ready situations to *opposite* recovery paths:
  a head whose worker has **not** handed off (no accepted `ready_for_review` and
  no degraded-CI escalation) belongs to worker-liveness recovery (report-stale /
  ping / respawn); a head whose worker **has** handed off via an evidence-backed
  **degraded-CI escalation** (required checks missing / never triggered) belongs
  to the orchestrator/reconciler degraded-CI branch (bounded re-attempt +
  observable operator escalation). The defer record MUST make these
  distinguishable: it MUST capture the kind/route of the latest accepted report
  for the current head, so "no hand-off yet" and "degraded-CI escalation accepted
  for this head" are not collapsed into one generic CI/report not-ready that sends
  the operator down the wrong recovery path. This issue does **not** re-specify
  #195's routing or the degraded-CI branch's handling — it only requires that
  which branch applies is **observable** from the record.
- **Multiple simultaneous causes are recorded, not collapsed to one.** A
  not-ready head frequently fails more than one sub-condition at once (e.g. no
  accepted `ready_for_review` *and* missing required CI; or a stale report *and*
  red CI). The defer record MUST NOT emit a single arbitrary failing cause that
  hides the others — that makes an operator fix one reason and rediscover the next
  only on a later tick. It MUST record **every** head-ready component observed as
  not-satisfied for this tick, and, where a single headline is needed, a
  **primary** chosen by a documented, deterministic precedence (the planner owns
  the precedence order, but it must be documented and stable, not
  evaluation-order-incidental).
- **Observed values are branch-complete.** Each no-start decision record MUST
  carry enough snapshot values to reproduce the *specific branch's* decision from
  the artifact alone, without re-querying volatile state after the fact — not just
  the CI/report fields. Concretely, the values MUST be sufficient to explain
  whichever branch fired: a report/CI not-ready defer needs the resolved current
  head SHA, the head SHA (if any) the latest accepted report was bound to, the
  **kind/route of that latest accepted report** (e.g. none / `ready_for_review` /
  degraded-CI escalation), and the CI classification plus which required-check
  source/set it was computed against; a **covered-skip** decision needs the
  identity and status of the matched covering run and the head/PR-linkage
  comparison that made it count as covered (per the #189
  predicate); a **failed/cancelled** defer needs the offending run's identity,
  status, and its termination/retry state. The *set of facts that must be
  reproducible* is the binding; the serialization, field names, and exact
  encoding are the planner's.
- **Ready head fires on the reconciler's own tick (liveness).** When a head
  satisfies the full #195 head-ready predicate, the **next reconciler tick** MUST
  start exactly one review run for it (subject to the existing #189/#195 pre-run
  re-check), independently of whether the LLM-orchestrator takes a turn or a
  heartbeat fires. A head that became ready after an earlier same-head defer MUST
  NOT require an orchestrator turn / heartbeat to be reviewed. This is the #163
  liveness invariant applied to the became-ready transition; it does not raise
  the reconciler cadence (the low-frequency contract of #163 §H Decision 2
  stands) — it only forbids a *separate* actor (heartbeat / LLM turn) being the
  sole thing that converges a head the reconciler could have started itself.
- **A prior same-head defer is never authoritative — re-evaluate every tick.**
  Each reconciler tick MUST decide a head's readiness by re-reading the
  authoritative inputs (the latest accepted worker report and its head binding,
  the required-CI state, and the #189 review-run coverage) for that tick. A
  cached, memoized, or otherwise carried-over not-ready verdict for the same head
  SHA from an earlier tick MUST NOT be treated as terminal or short-circuit the
  re-evaluation — otherwise a head that becomes ready between ticks stays deferred
  until a heartbeat/orchestrator turn, which is the exact regression this issue
  removes. (This is the suspected mechanism behind the PR #211 `01:48` defer;
  see **Open questions**.)
- **No change to gating, coverage, or worker lifecycle.** The #195 head-ready
  predicate, the #189 coverage predicate, and the #163/#97 safety invariants
  (no `ao spawn` / `--claim-pr` / `ao session kill` / worker `ao send`) are
  unchanged. A head that is genuinely not-ready still defers; this issue only
  makes that defer explain itself and guarantees a ready head converges on the
  reconciler's cadence. The subreason record is a decision log, not a new
  trigger input — it MUST NOT alter whether a run starts.
- **Operator adoption** (post-merge operator steps — not PR/planner edits;
  touches operator-facing surfaces):
  - If the subreason is surfaced in the reconciler's operator-visible log/state,
    document where the operator reads it (the defer subreason and observed
    values) in the recovery / go-live runbook, so a stuck-on-`not_ready` PR can
    be diagnosed without re-deriving the timeline by hand.
  - If a configuration knob is introduced, the PR edits only the
    `agent-orchestrator.yaml.example` mirror; **after merge the operator** copies
    that block into their live, gitignored `agent-orchestrator.yaml` and restarts
    per the runbook (the live file is operator-owned and out of scope for the PR —
    see **Files out of scope**). If no knob is added, state that no config change
    is required.

## Files in scope

- `scripts/**` — the state-derived reconciler entrypoint and its tests (the
  planner owns the file and the subreason representation; #163/#195 already place
  the reconciler here).
- `agent-orchestrator.yaml.example` — only if a config knob for the subreason
  log is introduced; otherwise untouched.
- `docs/**` — recovery / go-live runbook note on reading the defer subreason and
  observed values; `docs/migration_notes.md` operator subsection if a config
  change ships.
- Pack test fixtures/tests for the scenarios in **Acceptance criteria** (planner's
  choice of location).

## Files out of scope

- `packages/core/**`, `vendor/**` — never edited.
- The #195 head-ready predicate definition and the #189 coverage predicate —
  consumed unchanged; this issue does not re-specify *when* a head is ready or
  covered, only what a defer records and when a ready head converges.
- AO worker-spawn / lifecycle code paths, and the reconciler's existing
  no-spawn/no-kill/no-ping/no-claim safety.
- The orchestrator's finding-triage / fix-delegation / merge-decision logic.
- The live gitignored `agent-orchestrator.yaml` — operator-owned; only `.example`
  is edited in the PR.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. **Defer records a distinguishable subreason.** When the reconciler declines to
   start a run for an uncovered-but-not-ready head, the emitted decision names
   which #195 head-ready sub-condition was not satisfied, from a documented
   enumerable set (report-head binding; required-CI red vs missing/unknown vs
   not-yet-observed; failed/cancelled branch), and these stay distinguishable from
   the separate already-covered (`head_covered`) skip decision. Provable by
   fixtures presenting a head that is not-ready for each distinct cause and
   asserting the decision records the matching, distinct subreason — not a single
   opaque token.
2. **Simultaneous causes are all recorded.** Given a head that fails more than one
   head-ready component on the same tick (e.g. no `ready_for_review` *and* missing
   required CI), the defer record lists every failed component and a `primary`
   chosen by the documented precedence — not one arbitrary cause. Provable by a
   mixed-failure fixture asserting the full set and a deterministic `primary`.
3. **Observed values are branch-complete.** Each no-start decision carries values
   sufficient to reproduce *that branch* without re-querying volatile state: a
   report/CI not-ready defer carries the resolved current head SHA, the
   report-bound head SHA (or "none"), the kind/route of the latest accepted
   report, and the CI classification with its required-check source/set; a
   covered-skip decision carries the matched run's identity/status and the head/PR
   linkage comparison; a failed/cancelled defer carries the offending run's
   identity/status and termination/retry state. Provable by branch-specific
   fixtures (report/CI, covered-skip, failed/cancelled) each asserting the
   reproducing fields are present and match the input snapshot.
4. **Degraded-CI hand-off is distinguishable from "no hand-off yet."** Given a
   current head whose latest accepted report is a #195 degraded-CI escalation
   (required checks missing/unresolvable), the defer record marks it as the
   handed-off degraded-CI branch — not generic uncovered-but-not-ready
   worker-liveness — so an operator can tell the #195 degraded-CI recovery path
   applies. Provable by a fixture presenting a degraded-CI escalation on the
   current head and asserting the record's route/subreason is the degraded-CI
   branch, distinct from a no-`ready_for_review` defer on an otherwise identical
   head.
5. **Ready head fires on the reconciler's own tick.** Given a head that satisfies
   the full #195 head-ready predicate and is uncovered, the next reconciler tick
   starts exactly one review run, with no orchestrator turn or heartbeat occurring
   in the scenario. Provable by a test that runs a reconciler tick against such a
   snapshot (orchestrator simulated as stuck/idle) and asserts one run is created.
6. **No stale same-head defer — re-evaluation every tick.** A prior not-ready
   verdict for the same head SHA is never authoritative: each tick re-reads the
   authoritative report/head-binding, CI state, and #189 coverage before deciding,
   and a head that becomes ready between ticks is started on the next tick.
   Provable by an ordered fixture that reproduces the PR #211 shape — head pushed
   and CI green, an earlier tick defers the head as not-ready, then
   `ready_for_review` is accepted for the **exact** head **through the same
   durable inputs the reconciler reads** — asserting the subsequent reconciler
   tick (not a heartbeat / orchestrator turn) starts the run, and that the run is
   not blocked by any carried-over prior verdict.
7. **Subreason does not change gating.** The subreason record is decision metadata
   only: for every covered/ready/not-ready case the run-or-not outcome is
   identical to #195/#189 behaviour with the subreason logging absent. Provable by
   asserting outcomes are unchanged across the existing #195 trigger fixtures with
   the new logging in place.
8. **Safety invariants intact.** No fixture or shipped change introduces
   `ao spawn` / `--claim-pr` / `ao session kill` / worker `ao send`; the
   reconciler still takes no worker-lifecycle action for a deferred head. Provable
   by the existing forbidden-command / split-brain guards staying green and by
   inspecting the diff.
9. **Operator can diagnose a deferred PR.** The runbook documents where the
   operator reads the defer subreason and observed values for a PR stuck on
   not-ready, and (if a config knob ships) `agent-orchestrator.yaml.example` and
   `docs/migration_notes.md` carry it. Provable by inspecting those files.

## Open questions / risks

- **Was the PR #211 `01:48` defer a true negative or a predicate bug?** Not
  resolved from the artifacts — the report-to-head binding at `01:48` was not
  independently confirmed (the worker report claimed head `1607071` complete, but
  the snapshot the reconciler actually read at `01:48` was not captured). AC 1–4
  exist precisely so the *next* occurrence answers this from the log alone. If,
  once subreasons are live, a head meeting all four conditions is still observed
  deferring, that is a #195 predicate-evaluation bug to be filed separately
  against #195 — this draft deliberately does not pre-judge it, and fixing the
  predicate's evaluation is out of scope here (this issue makes it *diagnosable*
  and ensures the reconciler, not a heartbeat, converges a ready head).

## Upgrade-safety check

- No edits to AO core (`packages/core/**`) or `vendor/**`.
- No new or unsupported YAML schema fields; on AO 0.9.x a `reviewer:` block is
  silently ignored — any config stays in the supported surfaces the reconciler
  already uses.
- No new repository secrets; any new operator env/knob defaults to safe behaviour
  when unset and is documented.
- Composes with #163 (reconciler liveness/cadence), #195 (head-ready predicate),
  and #189 (coverage) rather than duplicating or contradicting them; the live
  `agent-orchestrator.yaml` is not committed.

## Verification

The planner proves done with checks/fixtures mapping 1:1 to acceptance criteria:

- Criterion 1: fixtures presenting a head deferred for each distinct cause,
  asserting a distinct subreason.
- Criterion 2: a mixed-failure fixture asserting the full set of failed
  components plus a deterministic `primary`.
- Criterion 3: branch-specific fixtures (report/CI, covered-skip,
  failed/cancelled) each asserting the branch-complete reproducing fields are
  present and match the input snapshot.
- Criterion 4: a fixture presenting a #195 degraded-CI escalation on the current
  head, asserting it records the degraded-CI branch and is distinct from a
  no-`ready_for_review` defer on an otherwise identical head.
- Criteria 5–6: a reconciler tick (e.g. the reconciler's existing `-Once`
  /dry-run-style path) over (5) a fully-ready uncovered head with the orchestrator
  simulated unavailable, and (6) the ordered PR #211 timeline fixture driven
  through the durable inputs, each asserting exactly one run started by the tick
  itself and not blocked by a carried-over prior verdict.
- Criterion 7: re-run the existing #195 trigger fixtures with the subreason
  logging present and assert identical run-or-not outcomes.
- Criterion 8: existing forbidden-command / split-brain guards green; `git diff`
  shows no lifecycle calls.
- Criterion 9: show the runbook (and, if a knob ships, the example config and
  `docs/migration_notes.md`) in the PR diff.
- Live smoke (operator, post-merge, optional): present an uncovered head that is
  not yet ready and confirm the reconciler log names the specific subreason; then
  make it ready and confirm a run appears in `ao review list --json` on the next
  reconcile tick without a heartbeat / orchestrator turn.
