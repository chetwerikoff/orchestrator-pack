# Orchestrator must start review within seconds of a ready head, not on the periodic poll

GitHub Issue: #207

## Prerequisite

Builds on already-merged / in-flight siblings:

- `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` (GitHub #163) —
  state-derived review **run** trigger, review-run only, never `ao send`. This
  draft adds a low-latency path in front of that reconciler; the reconciler stays
  as the backstop. **Context, not a gate.**
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub #189) —
  covered-head / no-rereview predicate this path MUST reuse for dedupe, **including
  its read-to-run TOCTOU as a residual** (not eliminated). **Context, not a gate.**
- `docs/issues_drafts/67-orchestrator-review-gate-on-handoff.md` (GitHub #195) —
  the canonical "head ready for review" predicate this path MUST consume verbatim
  (CI is **red-defers-only**, not green-required; failed/cancelled checked first;
  degraded-CI routes to escalation). **Context, not a gate.**
- `docs/issues_drafts/69-orchestrator-review-send-reconcile.md` (GitHub #202) —
  the delivery-side mirror (first `ao review send`). Same split-brain envelope; this
  draft is the trigger-side analogue (first `ao review run`). **Context, not a gate.**
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205) —
  **blocking.** The fast path issues `ao review run` (a side effect), so it needs draft
  71's side-effecting-child machinery (registry classification + drain/fence + restart/
  stall idempotency) **regardless of implementation path** — whether it adds a *new*
  long-running process or extends an *already-supervised* **registered** child (the wake
  listener) to issue review runs — **not** the LLM orchestrator turn, which 71 cannot
  supervise. Both paths reproduce the silent-death/stall and
  duplicate-side-effect class draft 71 exists to kill unless 71's machinery is in place
  first. The planner records which path it took; criterion 9 enforces the same supervision
  in either case.

**Decision (event-driven vs shorter interval) — logged.** An alternative is to keep
the #163 reconcile poll and simply shorten its interval to seconds. Rejected as the
primary mechanism: the operator wants near-instant convergence on the hand-off event,
not a faster busy-poll, and a usable near-real-time signal **already reaches the
supervised wake listener at hand-off** (see Binding surface). The shortened poll
remains available only as the backstop's tunable, not the design. This is the durable
record of the call; do not re-open it as "just lower the interval."

## Goal

Make the **first** `ao review run` for a worker's review-ready head converge within
seconds of the head becoming ready, **event-driven**, instead of waiting for the
periodic review-trigger reconcile (default 10 min) or the heartbeat backstop
(15 min). Today, after a worker hands off a review-ready head (per #195, CI
red-defers-only — not green-required), nothing fires a low-latency review trigger:
AO 0.9.x emits no wake-relevant webhook
notification on the `ready_for_review` / `review.pending` transition, and the only
completion-time notification — `approved-and-green` — is classified as a **merge**
wake, not a review-trigger wake. So the orchestrator's immediate turn carries the
wrong intent and review only starts on the next periodic tick. Close that latency
while preserving every split-brain invariant #163/#189/#202 established.

**Root cause (5 Whys, condensed).** Review did not start at hand-off → no low-latency
trigger fired → the only completion notification AO emitted was `approved-and-green`
→ the wake filter maps it to a **merge** intent, not a review-trigger, and AO 0.9.x
emits no `ready_for_review` notification at all → so the first `ao review run` falls
to the periodic reconcile/heartbeat. Incident 2026-06-05: PR #204, worker `opk-11`
review-ready ~11:51, review only ran ~11:56 via `heartbeat.reconcile`; the dedicated
review-trigger reconciler was separately dead (covered by draft 71).

## Binding surface

- **The driving signal must be named, not assumed.** The fast path is driven by an
  **existing** near-real-time signal that already reaches a supervised surface at
  hand-off — concretely, the completion-time AO wake delivered to the wake listener
  when the worker finishes (the **same** notification that today is classified as a
  merge wake; in the incident it arrived ~2 s after the worker became ready). The
  binding requirement: on receipt of that wake, when the head is ready-for-review per
  #195 and not covered, a **draft-71-supervised surface** (a registered side-process, or
  the wake listener reclassified as side-effecting — see criterion 9) drives `ao review
  run` **before** the wake is treated as merge-only. **Not a valid home: the LLM
  orchestrator turn** (`orchestratorRules`). The LLM turn is the slow, turn-gated path
  this draft exists to bypass, and it is **not** a detached child draft 71 can
  supervise/drain/fence — issuing the side-effecting run there reintroduces the
  unsupervised-side-effect failure class. The path must **not** assume AO emits a
  dedicated `ready_for_review` / `review.pending` notification (AO 0.9.x does not). Where AO
  emits **no** such completion wake (e.g. CI still pending so no approved-and-green),
  the periodic reconcile backstop is the convergence guarantee — the fast path is a
  latency improvement on top of, never a replacement for, the backstop. Implementations
  that add a new always-on poll/watch process instead of reacting to an existing wake
  must justify it against the shorter-interval backstop and satisfy the draft 71
  supervision prerequisite.
- **Scope of the seconds-level guarantee (honest about pending CI).** The instant
  trigger is promised **only** for heads where a completion/CI-settle wake actually
  reaches the listener — in practice the green-at-hand-off case (the incident class).
  A #195-eligible head whose required CI is still **genuinely pending/queued** is
  **eligible** (not deferred like red), but it is **not** promised a seconds-level fast
  trigger while no wake has fired: it converges either on the next completion wake when
  CI settles, or via the backstop. The draft must not claim instant convergence for a
  state in which AO emits no usable wake — that is the contradiction this bullet closes.
- **Readiness predicate = #195 verbatim (CI is red-defers-only).** A head is eligible
  exactly when the canonical #195 "head ready for review" predicate holds: latest
  accepted report is `ready_for_review` (or a #186 degraded-CI escalation, which routes
  to the degraded branch, not here) for the **exact** head SHA; required CI on that SHA
  is **green or genuinely pending/queued against a known required-check set** — **not**
  red/failing and **not** missing/unknown (degraded-CI escalation). The trigger does
  **not** require CI to be green; review and CI run in parallel. `failed` / `cancelled`
  on the current head is evaluated **first** (precedence) and routed to the EMPTY REVIEW
  TRAP (read `terminationReason`, retry-once), never treated as covered, before the
  head-ready predicate is applied.
- **Review-run only.** This path issues **only** `ao review run`. It MUST NOT spawn,
  `--claim-pr`, kill, merge, or `ao send` to a worker — identical envelope to
  #163/#191/#202. Driving the review is the entire scope.
- **Merge-intent wake ordering contract.** Because the driving signal is the wake AO
  today treats as merge-intent (`approved-and-green`), the path must define precedence:
  when that wake fires for a head that is review-eligible (uncovered per #189), the
  review trigger is evaluated **first**, and merge handling for that same wake must
  **re-read run state afterward** — it must **not** proceed to merge on the stale
  approved-and-green decision while a fresh review run is now in-flight / `needs_triage`.
  This reuses the existing "approved-and-green with `reviewDecision none` and no
  covered-terminal run is **not** mergeable" guard (empty-review trap / #54 terminal
  rule); the fast trigger must not create the inverse bug (review started after merge
  already decided). A fixture exercises a wake that is simultaneously review-eligible
  and merge-intent.
- **Covered-head dedupe via run state — bounded, not race-free.** Reuse the #189
  predicate: a `clean` / `needs_triage` / `waiting_update` (covered-terminal) or
  in-flight run on the exact head means **no new run**, re-checked on a fresh snapshot
  immediately before the run. This **bounds** but does not eliminate the read-to-run
  TOCTOU: the fast path, the periodic reconcile, and an LLM turn are independent
  observers with no shared atomic lock, so a concurrent double-observe can still issue
  a second run for the same head (**residual race, identical to #189** — do not claim
  it cannot happen). The required invariant is that the residual outcome is **benign**:
  at worst a redundant or `outdated` run for the correct head — never a run on the wrong
  head, and never any spawn/claim/kill/merge/send.
- **The run is bound to the prechecked SHA (no review of an unhanded-off head).** The
  `ao review run` MUST be bound to the exact PR + normalized head SHA that satisfied the
  #195 readiness snapshot. If the current head advances between the final snapshot and
  the command, the path **aborts/no-ops** rather than reviewing the new SHA — a new head
  is reviewed **only** after its own fresh #195 readiness snapshot (latest accepted
  `ready_for_review` for that exact SHA). This prevents reviewing an intermediate or
  unreported commit, which #195 exists to forbid; the backstop re-evaluates the new head
  on its next pass.
- **Periodic reconcile stays as the backstop.** This is an additive fast path. The
  #163 review-trigger reconcile and the heartbeat turn remain in place so a missed
  fast signal still converges; removing either is out of scope.
- **Operator adoption.** If the fast path introduces a new managed process, env var,
  or a changed wake mapping requiring `ao stop` / `ao start` or a wake-process restart:
  list the post-PR operator steps (any yaml-example merge, the process/launch change,
  new env with safe default, and the restart + a verification command). If it only
  changes already-supervised behaviour, state that no new operator process is added.
  Coordinate the supervised-liveness of any new process with draft 71 (do not ship a
  new unsupervised long-running process).

## Files in scope

- `scripts/**` — the fast-trigger path and its tests (new files as the planner
  declares them), consistent with the existing wake / reconcile scripts.
- `docs/**` — the wake-decision / event-filter surface and the go-live + recovery
  runbooks; `prompts/agent_rules.md` and the canonical `orchestratorRules` reference
  if the trigger contract is stated there.
- `agent-orchestrator.yaml.example` — only if the canonical `orchestratorRules` /
  notification-routing contract must change to express the fast trigger.
- Test fixtures for the readiness, dedupe, and latency scenarios.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**`.
- The local (gitignored) `agent-orchestrator.yaml` — operator-applied, not committed.
- Removing or rewriting the periodic review-trigger reconcile (#163) or the heartbeat
  (#168/#59) — they stay as backstops.
- Delivery of findings after review (`ao review send`) — owned by #202/#171.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. **Event-causal trigger.** Given a head that is ready-for-review per #195 with no
   covered-terminal or in-flight run for that exact SHA, a review run for that SHA is
   created in response to the completion-time wake, with no manual command. **Objective
   bound:** in a fixture where the periodic review-trigger reconcile and the heartbeat
   are disabled or not-yet-due, delivering the completion wake still produces the run —
   and **withholding** that wake produces **no** run from the fast path (only the
   backstop would later) — proving the trigger is event-driven, not poll-bound.
   **Falsifiable latency bound:** beyond causality, the path's **own** processing from
   wake receipt to the `ao review run` decision is asserted within a concrete
   **seconds-scale** upper bound in fixture/logical time — **excluding** explicitly
   modeled external AO/GitHub command latency and retry backoff. The planner picks and
   documents the exact number; the fixture asserts wake→run-decision stays under it, so a
   handler that defers the wake for minutes **fails** even when no periodic tick fired.
2. **CI classifier (#195 verbatim) — eligibility, not an instant promise.** A head with
   required CI **genuinely pending/queued** (known required-check set, not red) is
   **eligible** and triggers when a completion/CI-settle wake reaches the listener — it
   is **not** deferred like red, but it is **not** promised a seconds-level trigger while
   no wake has fired (it converges on CI-settle or the backstop). A **red/failing** head
   does **not** trigger (defers). A **missing/unknown** required-check head routes to
   degraded-CI escalation, not a fast-path run. Tests cover all four (green-wake-fires,
   pending-no-wake-defers-to-backstop, red, missing).
3. No run is created when a covered-terminal (`clean` / `needs_triage` /
   `waiting_update`) or in-flight run already exists for the head (reuses #189).
4. `failed` / `cancelled` on the current head is evaluated **before** the head-ready
   predicate, routed to EMPTY REVIEW TRAP (terminationReason + retry-once), and never
   treated as covered or reported as clean.
5. **Residual-race is benign + run is SHA-bound.** A fixture with two concurrent
   observers (fast path + reconcile, and/or an LLM turn) that both see an uncovered head
   produces at most a redundant/`outdated` run for the **correct** head — never a
   wrong-head run and never any spawn/claim/kill/merge/send. A fixture advancing the head
   **between** the final snapshot and the run shows the run is bound to the prechecked
   SHA and **aborts/no-ops** on advance — it never reviews the new (possibly
   intermediate/unhanded-off) SHA; that head is reviewed only after its own #195 snapshot.
6. **Merge-intent ordering.** A fixture where the completion wake is both review-eligible
   and merge-intent shows review is triggered first and merge handling re-reads state
   afterward — it does not merge on the stale approved-and-green decision while a fresh
   review run is in-flight / `needs_triage`.
7. The path issues only `ao review run`: a scope/test assertion shows it never spawns,
   `--claim-pr`s, kills, merges, or `ao send`s.
8. The periodic review-trigger reconcile and heartbeat remain functional as backstops
   (not removed); a fixture replay of the 2026-06-05 incident shows the run firing from
   the fast path rather than the heartbeat.
9. **Side-effecting behavior is supervised+fenced regardless of path (same-PR).** Either
   way the implementation goes, `ao review run` (a side effect) must land under draft 71's
   side-effecting-child machinery in the **same PR**:
   - **New process:** the same PR adds its draft-71 registry entry **and** its
     start/stop/status + restart-on-exit + stall-recovery + drain/fence/idempotency
     coverage — proven by a test/inventory check that the supervisor manages it (no
     out-of-registry sixth process).
   - **Extending an already-supervised child** (e.g. teaching the wake listener to issue
     `ao review run`): the same PR **reclassifies** that registered child as
     **side-effecting** in the registry and adds the same drain/fence/restart/stall/
     idempotency coverage around the in-flight `ao review run`. "Existing supervision
     already covers it" is **not** sufficient once a previously non-side-effecting child
     starts issuing review runs.
   In both cases a test shows no duplicate `ao review run` on restart/stall and no
   unsupervised side-effecting surface.

## Upgrade-safety check

- No edits under `packages/core/**` or `vendor/**`; AO is consumed, not patched.
- No unsupported YAML fields — drive review through the CLI; do **not** reintroduce a
  `reviewer:` block (silently ignored on AO 0.9.x).
- No new repository secrets.
- Children/processes stay independent — no shared failure path with the periodic
  reconcile or heartbeat.

## Verification

- pwsh 7+ tests / fixtures for criteria 1–9 (event-causality, CI classifier, covered
  dedupe, failed/cancelled precedence, residual-race benign-ness + SHA-bound run,
  merge-intent ordering, review-run-only scope, backstop survival, supervision),
  runnable in CI without a live AO.
- A dry-run / fixture demonstrates the wake→run causality for a ready head, **no** run
  for a covered / red-CI / intermediate-commit head, a triggered run for a pending-CI head
  **once a wake arrives** (CI-settle/green), and **backstop-only** convergence (no fast
  run) for a pending-CI head while no wake has fired — consistent with criterion 2.
- Where the contract lives in `orchestratorRules` / `agent_rules.md`, the strict
  diagnose path (`scripts/orchestrator-diagnose.ps1 -Strict` live, or the fixture gate
  in CI) still passes.
