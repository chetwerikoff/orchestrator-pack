# Orchestrator must not start the next review round until the worker hands off the current head

GitHub Issue: #195

## Prerequisite

- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub #189,
  merged) — covered-head idempotency. This draft is **additive**: #189 stops a
  *duplicate* run on the *same* head SHA; this draft stops a *premature* run on a
  *new* head SHA before the worker has handed it off.
- `docs/issues_drafts/64-pr-created-not-terminal-worker-handoff.md` (GitHub #186,
  merged) — supplies the worker-side `ready_for_review` hand-off obligation and the
  "ready_for_review counts only for the PR current head at report time" semantics
  this gate consumes.
- `docs/issues_drafts/66-orchestrator-ci-green-wake-worker.md` (GitHub #191, open)
  — not blocking. It wakes the worker on CI-green so the hand-off arrives faster;
  it is an enabler for this gate, not a precondition.

## Goal

The orchestrator must trigger the next review round on an advanced PR head **only
after the worker has handed that head off** — i.e. the head is reported
`ready_for_review` for that exact SHA and required CI on it is **not red/failing**
(red defers; genuinely pending checks allow review in parallel — see Binding
surface for the full CI contract; the trigger is deliberately **not** coupled to
merge-green CI). Intermediate or in-progress commits a worker pushes while still
fixing the current round must not trigger a review run. This eliminates review runs that fire mid-fix, the
`outdated` runs they leave behind, and findings delivered against a SHA the worker
has already moved past.

## Background (5 Whys — failure response)

Observed: review runs start before the worker finishes the current round of fixes;
runs pile up and several go `outdated`.

1. A new run is started on every head-SHA advance (`ROUND PROGRESSION`) or whenever
   the low-frequency reconciler sees an uncovered head (`STATE-DERIVED REVIEW
   TRIGGER`, #163).
2. Those two trigger paths key off **head-SHA coverage only** — neither requires the
   worker to have signalled the round complete for the new head.
3. Workers push intermediate commits while still fixing; each push advances the
   head, marks the prior run `outdated`, and makes the head look uncovered mid-fix.
4. Covered-head idempotency (#98/#189) was scoped to the *same* SHA; coverage is
   per-exact-SHA, so any new SHA is always "uncovered" and re-triggers.
5. **Root cause:** the spec never defined "round complete / safe to review" as a
   per-head worker hand-off condition for the SHA-advance and reconciler paths. The
   report-driven path (`TRIGGER REVIEW WITHOUT HUMAN PROMPT`) *is* gated on
   `ready_for_review`; the other two paths are not — an inconsistency.

## Binding surface

This issue commits the repository to a single hand-off predicate that **all**
review-trigger paths share, replacing the current SHA-advance-only triggers.

- **One canonical predicate — "head ready for review."** A PR head SHA is *ready
  for review* when ALL hold against one consistent snapshot:
  - the latest accepted worker report for that **exact current head SHA** is
    `ready_for_review` (a `ready_for_review` reported for an earlier head SHA does
    not authorise review of a later head — reuse the #186 "current head at report
    time" semantics);
  - required CI (the pack merge-contract definition already in `orchestratorRules`
    / `agent_rules.md`) on that same head SHA is classified **green or genuinely
    pending/queued against a known required-check set** — explicitly **not**
    red/failing and **not** missing/unknown/unresolvable (the latter is not
    "head ready for review"; it routes to degraded-CI escalation per the CI
    contract below);
  - the head is not already covered per the #189 covered-head predicate (no
    duplicate run); **and**
  - the current head has **no** `failed`/`cancelled` run awaiting EMPTY REVIEW TRAP
    handling (see precedence below).
- **Decision precedence — failed/cancelled is checked first.** A `failed` or
  `cancelled` run on the current head is *not* covered, so it must **not** fall
  through to the normal head-ready path and start an unconditional new run. Every
  trigger path evaluates failed/cancelled-on-current-head **before** the head-ready
  predicate and routes it to EMPTY REVIEW TRAP (read `terminationReason`, retry at
  most once after diagnosis, escalate otherwise) — never to the plain
  uncovered-ready start path. Head-ready eligibility applies only after that branch
  is cleared.
- **Hand-off input recognition (ready_for_review vs degraded-CI escalation).** The
  worker can hand a head off in two ways under #186: a `ready_for_review` report, or
  an **evidence-backed degraded-CI escalation** (required checks missing / never
  triggered), after which the worker is allowed to stop. Both mean "the worker has
  handed off," but only `ready_for_review` enters the head-ready path. A current
  head whose latest accepted report is a #186 degraded-CI escalation must route
  **directly** to the orchestrator/reconciler degraded-CI branch below (bounded
  re-attempt + observable operator escalation) and must **not** be classified as
  generic uncovered-but-not-ready — otherwise a CI-visibility failure would be
  mishandled as a worker-liveness problem owned by `report-stale`/ping/respawn.
- **CI is red-defers-only — review and CI run in parallel.** The trigger does
  **not** require CI to be *green*. The required-check set for the head is resolved
  from the **same source the pack's existing Required CI definition already uses**
  (branch-protection required checks, or the documented merge-contract fallback
  set), and the CI state is classified against that set:
  - **red/failing** on the head → **defer** (the worker is in `fixing_ci` and will
    push a new head, so a run on that SHA would be wasted — cost rule);
  - **green**, or **genuinely pending/queued** (the required checks for the head are
    known and in flight) → **eligible**; the review run proceeds concurrently with
    CI. Rationale: a valid `ready_for_review` already encodes the worker's CI-gate
    compliance (the worker may not report `ready_for_review` while required CI is
    red), so coupling the trigger to merge-green CI would only let pending/flapping
    checks starve review feedback.
  - **missing / unknown / degraded visibility** — the required-check set cannot be
    resolved for the head, branch protection is unreadable, or required jobs are
    absent — is **not** auto-eligible and must **not** be silently reviewed, but it
    must **not** be silently suppressed forever either. Reuse the existing "missing
    required checks are not green" rule, and because the worker has **already**
    handed off (the worker-side #186 path no longer applies), define an explicit
    **orchestrator/reconciler** outcome: bounded re-attempts to resolve the
    required-check set for the head, and on continued failure an **observable
    operator escalation** (notify-class action naming the PR and the unresolved
    required-check visibility) — not a state the head can sit in indefinitely
    unreviewed and un-escalated. This must not re-introduce merge-green coupling for
    the normal green/pending path — it only withholds the *automatic* trigger when
    CI applicability itself is unprovable, while still converging via escalation.
  Flapping is handled by snapshot semantics below — each trigger decision uses the
  CI state observed for the current head; a later flip re-gates on the next head.
- **All trigger paths consume this predicate.** The report-driven trigger,
  `ROUND PROGRESSION`, and the #163 state-derived reconciler must each start a new
  `ao review run` only for a head that is *ready for review* by the definition
  above. A head that is uncovered but **not** ready ("uncovered-but-not-ready") is
  left alone: no review run, and — for the reconciler — no worker-lifecycle action
  (its existing no-spawn/no-kill/no-ping/no-claim safety is unchanged).
- **Defer, never drop — with a bounded convergence path.** The gate only *delays*
  the next round until hand-off; it must not introduce a new terminal stall. A head
  held as uncovered-but-not-ready must remain visible to the existing recovery
  backstops so it converges in bounded time rather than sitting silently forever:
  `report-stale` (~30 min) and the ping/respawn discipline drive an idle or dead
  worker toward hand-off or operator escalation, and the #191 CI-green wake
  (enabler, not relied on as the sole path) speeds re-engagement after `fixing_ci`.
  The gate adds no new watchdog and disables none; it must be shown not to remove a
  never-hand-off head from those backstops' reach (acceptance criteria below).
- **Pre-run revalidation (single source — reuse #189).** Every trigger path must
  re-read the current PR head SHA, the latest accepted worker report for that head,
  the required-CI state, and #189 coverage immediately before emitting
  `ao review run`, with the smallest gap between read and run, and abort the run if
  the predicate no longer holds. This reuses and widens #189's existing PRE-RUN
  COVERAGE RE-CHECK rather than defining a parallel mechanism, so concurrent pushes,
  stale reports, reconciler/orchestrator overlap, and restart-with-stale-state
  cannot resurrect the outdated/duplicate-run behaviour this gate removes.
- **Failed / cancelled on the current head** keeps its existing handling (EMPTY
  REVIEW TRAP: read `terminationReason`, retry once after diagnosis, escalate) — a
  failed run is still not "covered" and not "ready," and the gate does not change
  that path.
- **Operator adoption:** the canonical rule lives in `orchestratorRules` (and the
  `agent-orchestrator.yaml.example` mirror) plus `prompts/agent_rules.md`; the
  reconciler script change ships in the repo. After merge the operator must merge
  the updated `orchestratorRules` block into the live (gitignored)
  `agent-orchestrator.yaml`, then `ao stop` and `ao start`; redeploy the reconciler
  process if it runs as a standalone loop. List these in the PR `## Operator
  adoption checklist` and the matching `docs/migration_notes.md` subsection.

## Files in scope

- `agent-orchestrator.yaml.example` — canonical `orchestratorRules` (and any
  affected `reactions`).
- `prompts/agent_rules.md` — universal worker/orchestrator rule mirror.
- `scripts/**` — the state-derived reconciler that applies the uncovered-head
  predicate today (planner picks the exact file and shape).
- `docs/**` — autoloop go-live / recovery-runbook prose that documents the trigger
  conditions, and `docs/migration_notes.md` operator subsection.
- Pack test fixtures/tests covering trigger gating (planner's choice of location).
- `docs/issues_drafts/00-architecture-decisions.md` — if a DD-level decision is
  recorded for the shared predicate.

## Files out of scope

- `packages/core/**`, `vendor/**` — never edited.
- The live gitignored `agent-orchestrator.yaml` — operator-owned; only the
  `.example` mirror is edited in the PR.
- Worker CI-gate semantics for emitting `ready_for_review` (owned by #186) — this
  draft consumes that signal, it does not redefine when the worker may emit it.
- The covered-head predicate itself (#189) — reused unchanged, not re-specified.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. There is **one** documented "head ready for review" predicate, referenced by all
   three trigger paths (report-driven, `ROUND PROGRESSION`, #163 reconciler) — no
   path carries an independent or contradictory trigger condition.
2. A new review run is started for an advanced head only when that exact head is
   `ready_for_review` (matching the current head SHA), required CI is classified
   **green or genuinely pending/queued against a known required-check set** (not
   red/failing and not missing/unknown/unresolvable), it is not already covered
   (#189), **and** the head has no `failed`/`cancelled` run awaiting EMPTY REVIEW
   TRAP handling — that branch is evaluated first (criterion 9) and never reaches
   the plain uncovered-ready path.
3. A worker pushing an intermediate commit on the PR branch **without** a
   `ready_for_review` for that new head does **not** cause any trigger path to start
   a review run; the head is treated as uncovered-but-not-ready.
4. A `ready_for_review` reported against an older head SHA does not authorise a
   review run on a newer head SHA.
5. The #163 reconciler takes **no** worker-lifecycle action (no spawn, claim-pr,
   kill, ping) for an uncovered-but-not-ready head — only the review-run decision
   changes; its existing safety invariants still hold.
6. **CI degraded states are explicit:** an otherwise-ready head with **green or
   genuinely pending/queued** required CI (the required-check set is known) **does**
   trigger a review run (review parallel to CI); an observed **red/failing** head is
   deferred; a head whose required-check set is **missing / unknown / unresolvable**
   is **not** silently reviewed and — when the worker has already handed off — is
   handled by the **orchestrator/reconciler degraded-CI branch** (bounded re-attempt
   + observable operator escalation per criterion 7b), **not** sent back to the
   worker-side #186 path. Review throughput is not coupled to merge-green CI for the
   normal green/pending path.
7. **Convergence is observable in both stall classes — no silent forever-suppress:**
   (a) *pre-hand-off* — a head held as uncovered-but-not-ready remains reachable by
   `report-stale` and ping/respawn discipline so an idle-live or dead/missing worker
   converges to hand-off or operator escalation in bounded time; the gate adds no
   new watchdog and removes no head from those backstops; (b) *post-hand-off
   degraded CI* — an already-handed-off head whose required-check set stays
   missing/unknown/unresolvable triggers a bounded orchestrator/reconciler
   re-attempt and then an observable operator escalation, so it cannot sit
   unreviewed and un-escalated indefinitely (the worker-side #186 path does not
   cover this because hand-off already happened).
8. **Pre-run revalidation:** every trigger path re-reads current head SHA, latest
   accepted report, required-CI state, and #189 coverage immediately before
   `ao review run` and aborts if the predicate no longer holds (reuses #189's
   PRE-RUN COVERAGE RE-CHECK; no parallel mechanism).
9. `failed` / `cancelled` runs on the current head keep EMPTY REVIEW TRAP handling
   (not treated as covered or ready; retry-once-after-diagnosis preserved).
10. Pack tests/fixtures demonstrate, at minimum: (a) ready head triggers exactly
    one run; (b) intermediate commit does not trigger; (c) stale `ready_for_review`
    for an older head does not trigger; (d) red CI on an otherwise-ready head does
    not trigger; (e) genuinely pending/queued CI (required-check set known) on an
    otherwise-ready head **does** trigger; (e2) an already-handed-off head whose
    required-check set is missing/unresolvable does **not** silently trigger, and
    after bounded re-attempts reaches an observable operator escalation (no silent
    forever-suppression); (e3) a current head whose latest accepted report is a #186
    degraded-CI escalation (not `ready_for_review`) routes to the degraded-CI branch
    (bounded re-attempt → operator escalation), not to generic
    uncovered-but-not-ready worker-liveness handling;
    (f) idle-live and dead/missing worker on a held head stay reachable by the
    backstops (no permanent suppression); (g) head/coverage advancing between
    observation and the pre-run re-check aborts the run.

## Upgrade-safety check

- No edits to AO core (`packages/core/**`) or `vendor/**`.
- No new or unsupported YAML schema fields; the change stays inside
  `orchestratorRules` / `reactions` prose and the reconciler script.
- No new repository secrets.
- The live `agent-orchestrator.yaml` is not committed; only `.example` is edited.

## Verification

1. Confirm criterion 1 by inspecting the canonical predicate text in
   `agent-orchestrator.yaml.example` and `prompts/agent_rules.md` and that each
   trigger path references it.
2. Run the pack contract tests covering trigger gating (criterion 10) and show all
   scenarios pass: ready→one run; intermediate→no run; stale-ready→no run;
   red-CI→no run; pending/queued CI with a **known** required-check set→run;
   missing/unknown/unresolvable required checks→no run + escalation routed;
   idle-live and dead worker stay reachable by backstops;
   advance-between-observation-and-re-check→abort.
3. Dry-run the reconciler against a fixture/synthetic `ao review list` +
   `gh pr list` + `ao status` snapshot showing an uncovered-but-not-ready head and
   confirm it emits no `ao review run` and no lifecycle action
   (e.g. the reconciler's existing `-Once -DryRun` style verification path).
4. Demonstrate the pre-run revalidation (criterion 8): a fixture where head or
   coverage changes between first observation and the immediate pre-run re-read
   yields no `ao review run`.
5. Confirm the operator adoption steps (live YAML merge, `ao stop`/`ao start`,
   reconciler redeploy) appear in the PR checklist and `docs/migration_notes.md`.
