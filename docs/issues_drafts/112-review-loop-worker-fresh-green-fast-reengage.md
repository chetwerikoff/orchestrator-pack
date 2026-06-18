# Fast re-engagement for a review-loop worker idling on a fresh green head it never re-reported

GitHub Issue: #348

## Prerequisite

- `docs/issues_drafts/85-review-trigger-terminal-worker-fallback.md` (GitHub #261,
  closed) — the review-trigger fallback that starts a review for a CI-eligible,
  uncovered head whose **live** owner has gone quiescent past a debounce without
  `ready_for_review`, including **row 5** (a `ready_for_review` bound to a
  stale/older head is treated as report-absent for the current head → starts). This
  issue **shortens the path** for one sub-case #261 already covers slowly; it does
  not change #261's live-target constraint, fail-closed binding, or TOCTOU guard.
- `docs/issues_drafts/106-review-and-cinudge-per-cycle-settle-gate.md` (GitHub
  #332, closed) — the per-worker-iteration **cycle** gate (`already_reviewed_this_cycle`
  / `already_nudged_this_cycle` / `handoffAccepted`) that armed review-start and
  CI-green nudge **once per cycle**, closing the per-commit re-arm storm (PR #327).
  This issue's fast branch is **subordinate to that gate** — it never re-arms
  within a settled cycle.
- `docs/issues_drafts/88-review-start-atomic-claim.md` (GitHub #267) and
  `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md` (GitHub
  #308), and the LLM-turn process-boundary gate (GitHub #318) — the single-winner
  per-`(PR, head)` review-start claim every automated starter passes. The fast
  branch starts review through the **same** claim; it adds no new unclaimed start
  surface.
- The shipped CI-green wake reconciler (GitHub #191) defines
  `PRE_HANDOFF_REPORT_STATES = {fixing_ci, working, pr_created}` and
  `POST_HANDOFF_REPORT_STATES = {ready_for_review, addressing_reviews}`, and
  **skips** a post-hand-off worker with `post_handoff_or_ineligible_report` (#174:
  the review loop, not the CI nudge, drives a worker once it has handed off). That
  skip is correct and **stays** — this issue does not re-open the CI-green nudge to
  post-hand-off workers.

## Goal

A worker that is **already in the review loop** — a **terminal review run exists for
an earlier head of this PR and the worker re-engaged after it** (received findings,
worked, i.e. `addressing_reviews`) — finishes addressing those findings, pushes a
**fresh head distinct from the reviewed one**, that head goes **CI-green and stays
uncovered**, and the worker then **idles without re-reporting `ready_for_review` for
the new head**. The review for that green head must start **promptly**, not only
after the full sustained-quiescence debounce #261 applies to never-handed-off
workers. (v1 requires a prior **consumed review run**; a stale-bound
`ready_for_review` on an older head with **no** consumed review run is **not**
fast-eligible and falls back to #261 — see Binding surface.)

Today this worker falls through every fast path: #191 skips it
(`post_handoff_or_ineligible_report`, by design), the report-driven trigger
(#195/#207) defers it (`no_ready_for_review` for the current head), and #261 starts
it only after a debounce sized to avoid misclassifying an *actively-working*
worker — so a finished, green, already-once-handed-off PR sits un-reviewed for the
whole debounce window with no faster signal. The incident: PR #344 / opk-34,
2026-06-18 — head green and uncovered, worker idle, no `ready_for_review` on the
current head, both automated nudge/start paths inert.

```behavior-kind
action-producing
```

## Binding surface

- **One new *fast-eligible* branch in the shipped review-trigger reconciler's
  eligibility decision**, narrower than #261's general quiescence branch and gated
  by a **prior-hand-off signal**: a PR whose current head is **CI-green** (the fast
  path is **green-only** — *not* the broader #207 pending-known eligibility; a
  pending-known head defers to the report-driven/#261 paths) and **uncovered**, has
  **no** `ready_for_review` bound to that current head, whose owning session is
  **live and idle with no pending/unconsumed delivery and a stable head**, **and**
  for which authoritative orchestrator state proves the owner **previously handed
  off this PR at least once** (see the prior-hand-off binding bullet) becomes
  review-eligible on a **short** debounce — distinct from, and shorter than, #261's
  general sustained-quiescence debounce. The prior hand-off is the confidence that
  lets the debounce be short: a worker that already proved it knows how to hand off,
  is back on a fresh green head, and has fallen idle is a high-confidence "done"
  signal, not an unfinished first draft.
- **Short-debounce basis (what must be true — planner picks the constant).** The
  short debounce is an **elapsed-idle** measurement from an **authoritative,
  restart/respawn-comparable** timestamp of the worker's last activity/head change —
  the AO-recorded last-activity/heartbeat value that **survives a reconciler restart
  and is comparable across the worker's respawn lineage**, *not* the reconciler's
  process-local monotonic clock (which resets on restart) and *not* its own tick
  count. A reconciler or worker restart near the debounce boundary must not let the
  fast branch fire immediately, defer forever, or compute elapsed-idle from the wrong
  epoch (fixture below). It is bounded on **both** ends: strictly **shorter
  than** #261's general sustained-quiescence debounce (this branch's reason for
  existing), and **floored above a non-trivial minimum > 0** so it can never collapse
  to "fire on the first idle tick" and review a worker between two keystrokes. The
  exact value and clock source are the planner's, stated explicitly in the
  implementation with the chosen basis recorded; the draft is non-actionable until
  that source is named.
- **The prior-hand-off signal is the safety-bearing predicate, bound to the current
  owner.** The fast branch fires only on durable, authoritative evidence that *this*
  PR was handed off before **by the session that owns the current head** — bound to:
  (a) the **same PR**; (b) the **same current live owning session**, or an
  explicitly valid ownership lineage (a resolvable respawn/rotation of that owner) —
  a prior hand-off from a *different* or unresolvable session does **not** count; and
  (c) a **consumed review round** on an **earlier head distinct from the current
  head** — defined as **both** a **terminal review run** (with a durable review-run
  id) for a strictly prior head of this PR **and** evidence the worker **re-engaged
  after it** (received the findings and worked them — an `addressing_reviews`
  transition, then produced the current distinct head). A terminal run **alone** is
  **not** "consumed": a clean-pass / failed / non-delivered prior run with no
  re-engagement must **not** mint a cycle or license a fast start (that would review
  an unconsumed-findings state). **v1 scope (deliberate):** the prior hand-off must
  be a **consumed review round** as just defined; a stale-bound `ready_for_review` / post-hand-off
  report with **no** consumed review run is **not** fast-eligible and falls back to
  #261's normal path. This keeps the round key a real, durable review-run id (no
  surrogate-identity machinery, no "what opens the cycle for a report-only case"),
  and still covers the incident — opk-34 was in `addressing_reviews`, i.e. a review
  round had been delivered, so a review-run id exists. (Extending fast eligibility to
  report-only prior hand-offs is a deferred follow-up, gated on a durable consumed-
  round identity it does not have today.)
  Without all three the fast branch does **not** fire — the PR falls back to #261's
  normal (longer) quiescence path. A first-ever head with no prior hand-off, or a
  prior hand-off that cannot be bound to the current owner, is **not** fast-eligible
  (it is #261 row 1's slow case), so this branch never shortens the guard that
  protects a never-handed-off first draft and never trusts a stale-ownership signal.
  The **valid-lineage** case is itself safety-bearing (a too-broad respawn/rotation
  match could bind a prior hand-off from the *wrong* live session): the
  implementation must name the **authoritative** ownership-lineage source from
  orchestrator state and accept a lineage only when it positively resolves to *this*
  owner; a parallel/different live session with superficially similar PR/head
  history **fails closed**. Both the positive (valid respawn → fast-eligible) and
  negative (look-alike session → fail closed) cases are fixtures.
- **Subordinate to the #332 per-cycle gate — but a delivered review round opens a
  new cycle (non-negotiable, and the crux of the incident).** The fast start is
  gated by both the single-winner review-start claim and the per-worker-iteration
  **cycle** machine, firing **at most once per worker-iteration cycle**
  (`already_reviewed_this_cycle` blocks a second) so several fresh heads inside one
  cycle do not re-arm a storm. **Critically:** the incident worker had *already*
  armed a review start for its **earlier** head in its prior cycle, then received
  findings and pushed a fixed head. The fast branch must therefore fire in the
  worker's **next** cycle — the prior cycle's `already_reviewed_this_cycle` must
  **not** suppress the fresh-head start. The spec requires that **delivery/acceptance
  of a review round (the worker re-engaging on findings — `addressing_reviews` →
  new work, then a fresh head) opens a new worker-iteration cycle**, so the
  fresh-fixed-head fast-start is evaluated in a *new* cycle, not blocked by the prior
  review's arm. If the existing #332 cycle-rollover does not already open a new cycle
  on a post-review fresh head, this issue makes it do so; otherwise it relies on it.
  A second fast start *within the same* (already-armed, no new round) cycle stays
  blocked.
- **Cycle rollover is a durable, idempotent, one-time transition — never a
  per-tick derived reset.** The new cycle is opened **once**, keyed by the
  conjunction (prior review delivery/run id, PR, new head SHA, owner lineage), and
  persisted; subsequent reconciler ticks observing the same conjunction must **not**
  mint a fresh cycle again. **A "new round" is discriminated by a newly-consumed
  review delivery/run id, not by the head SHA alone** — so a force-push/amend/SHA
  reuse *after* the same consumed round does **not** collapse a genuinely new
  iteration into the old conjunction (suppressing a needed start), and an
  owner-lineage change with **no** new consumed round does **not** masquerade as a
  new round (minting a false cycle). The head SHA is part of the key but does not by
  itself open a cycle without a new consumed round.
  A rollover recomputed every tick would keep resetting
  `already_reviewed_this_cycle` after the first fast start and re-arm duplicate
  review runs for the same green head (the single-winner claim only serialises a
  given head — it does not stop a freshly-minted cycle from re-evaluating). The
  rollover must be a recorded state transition, not a predicate the reconciler
  re-derives, so exactly one fast start can fire per genuinely-new round. The
  rollover must be **durable across a reconciler restart/reload** (persisted, not
  in-memory): a restart after the cycle opened or after the fast start armed must
  **not** re-mint the cycle or re-arm a second start. And the rollover's effect is
  **scoped to the review-start latch** for the fresh post-review head — it must
  **not** also reset `already_nudged_this_cycle` or `handoffAccepted` in a way that
  re-enables a CI-green nudge or handoff behaviour #332 deliberately suppressed
  (regression-guarded).
- **Persistence uses the existing mechanical-json-state discipline — no new unsafe
  side file.** The rollover/latch markers live in the reconciler's **existing**
  per-cycle state surface (the same `Get-/Set-MechanicalJsonStateFile` atomic-write
  + quarantine-on-corruption discipline #332's cycle state already uses), in the
  reconciler's existing state root — **not** a bolted-on side file, **not** `.ao/**`
  (denylisted), **not** AO core. A torn/partial write, an empty store on a fresh
  root, or a stale/incompatible schema must be handled by that discipline
  (quarantine + fail-closed re-derive), proven by a corrupt-/empty-state fixture, so
  a persistence fault can neither re-mint a cycle (duplicate starts) nor silently
  swallow the needed fast start. **Reconstruction source of truth on corrupt
  state:** the durable cycle/latch store is an *optimization*, not the authority —
  after quarantine the reconciler re-derives from the **primary authorities** —
  `ao review list` **coverage** and the **single-winner claim store** (already durable
  under #308/#308's discipline) — before re-arming: head already covered / claimed /
  started → does **not** re-start (no duplicate); uncovered, unclaimed, still eligible
  → **starts** (no swallow). The review-start **audit record is corroborating only,
  not an authority** — it is **not** relied on as durable/ordered; when coverage and
  the claim store suffice to decide, audit is not consulted, and when the available
  signals **disagree or cannot be read**, the reconciler emits a **terminal
  operator-visible defer** rather than asserting both guarantees blindly. Because the
  claim store already prevents a duplicate even if the cycle marker is lost,
  reconstruction is safe by construction without depending on audit durability.
  **The per-`(PR, head)` claim is round-agnostic**, so reconstruction must not read
  "a claim exists for this head" as "the current round already started": a claim
  from an **older, abandoned** round (terminal or non-terminal, possibly pending
  #308 release) must not cause a false no-start for a genuinely uncovered later
  round, nor a premature re-start while release races rollover. Either the
  cycle/round id is stored **with** the claim (or recoverable from it), or
  reconstruction treats an older-round claim as non-authoritative for the current
  round and decides from coverage + a fresh claim attempt; the ambiguous case
  emits a terminal defer rather than guessing.
- **Rollover is robust to snapshot observation order.** The reconciler observes
  external **state snapshots**, not an ordered event stream: across ticks it may see
  the fresh head **before** the consumed-delivery becomes visible, or the consumed
  delivery **before** the fresh head is stable. The one-time rollover must open
  **exactly one** cycle for the intended (consumed-round, head) pair regardless of
  which it observes first — it must not miss the rollover, defer to #261
  unnecessarily, or later mint it against the wrong conjunction. The cycle opens only
  once **both** halves of the conjunction are observed together in one snapshot;
  observing one half early holds (defers) rather than opening prematurely.
- **Cycle-open and start-armed are DISTINCT persisted facts (crash-ordering).**
  Opening the new cycle does **not** by itself mark the start armed. The fast branch
  fires when the cycle is current **and** `already_reviewed_this_cycle` is **not**
  set for it; the latch is recorded only when the start actually arms. So a crash
  **after** the cycle persisted but **before** the claim/latch — the dangerous
  ordering — leaves the cycle open with the start **un-armed**: the next tick sees a
  current cycle + un-armed start + still-eligible head and **starts** (it neither
  skips forever nor mints a second cycle). The recovery completes the pending start;
  it never treats "cycle opened" as "review started."
- **Same single-winner claim, same live-target constraint, same crash-safe
  release.** The fast start emits `ao review run` through the existing atomic
  per-`(PR, head)` claim (#267/#308/#318) and only ever targets a **live** session
  (`ao review run` refuses non-live sessions). A not-live/orphan owner is **out of
  scope** and fails closed (same as #261). No new unclaimed start surface; no second
  concurrent start for the head. The fast start adds **no new crash/recovery
  semantics** beyond #308: a claim acquired but whose review run never reached
  terminal coverage is recovered by #308's claim-release-on-terminal-failure (the
  claim is released and the head re-evaluated, not duplicated and not left
  permanently uncovered). A fixture exercises the claim-acquired / review-not-yet-
  terminal interleave to prove the fast path inherits that recovery rather than
  introducing a duplicate-on-retry or stuck-uncovered path.
- **Active-work and pending-delivery guards unchanged, scoped to the relevant
  round.** While the owner is actively working (mid-turn, head moved within the
  debounce, or holds a pending/unconsumed delivery), the fast branch does **not**
  fire — the #195 gate and #332 `worker_actively_working` /
  `pending_unconsumed_delivery` blockers stay in force. The **pending-delivery**
  guard is scoped to **the same PR and the same current owner/lineage** and, where
  the delivery is correlatable, to **the review-findings delivery of the current
  iteration** — so the case it must block is *findings sent but not yet consumed*
  (starting then would review ahead of work the worker is about to do). A delivery
  that **cannot** be correlated to the current round but is bound to this owner/PR
  is treated **fail-closed** (defers, logged), not silently ignored — premature
  review is the worse failure; the head is re-evaluated next tick and #261's slow
  path remains the eventual backstop, so a stale uncorrelated delivery cannot wedge
  it forever. Idle + stable green head + no relevant pending delivery + prior
  hand-off is the full predicate.
- **An uncorrelated stale delivery must not wedge the head forever (bounded).** The
  fail-closed defer on an owner/PR delivery that cannot be correlated to the current
  round is **bounded**, not indefinite: it gates only the *fast* branch. But
  **uncorrelated ≠ stale** — an uncorrelated delivery may be a *current* findings
  delivery the state surface merely failed to parse, so #261 may **bypass** it and
  start **only after the delivery is independently proven stale / terminal /
  old-round**; an uncorrelated-but-not-proven-stale delivery does **not** license a
  start (reviewing ahead of unconsumed findings causes false-clean passes), it
  escalates to a **finite operator-visible terminal defer**. The spec must prove the
  unwedge **mechanism**, not
  merely assert it — either #261's path explicitly ages/ignores an uncorrelated
  stale delivery after its long debounce, or the fast branch escalates an
  operator-visible terminal defer for a stale delivery past a finite bound. "Next
  tick" alone is not recovery when the delivery record is durable. (Delivery
  aging/expiry itself stays out of scope — `89-…`/#216 own it; this issue only
  guarantees the head is not permanently un-reviewable because of one.)
- **#261 fallback precedence is explicit per fail-closed reason.** "Falls back to
  #261" must not let #261 start through a state the fast branch **safely** rejected.
  Split the fast-branch fail-closed reasons: **safety-shared** reasons —
  ambiguous/unresolvable owner, not-live/orphan owner, ambiguous prior hand-off,
  coverage/report mismatch — are constraints **#261 already enforces too** (live
  single-owner target, covered-head idempotency), so #261 must **also** defer/fail
  closed on the same state; it may start **only** after independently revalidating
  its own stricter live-owner/current-head predicates from a fresh snapshot, never by
  reusing the fast branch's rejected snapshot. **Fast-ineligibility-only** reasons —
  no prior hand-off, within-the-short-debounce, lineage-not-yet-established — are
  *not* safety failures: #261's normal (longer) quiescence path may still start once
  *its* predicate is met. The implementation states this precedence per reason.
- **Pre-run revalidation (TOCTOU), reused from #261.** Immediately before emitting
  `ao review run`, the reconciler re-reads one fresh snapshot (current head,
  coverage, report binding, CI eligibility, owning-session identity + liveness,
  idle/no-pending-delivery basis, prior-hand-off evidence, and open
  review-revision/cycle state) and aborts fail-closed if any changed: the worker
  resumed, a `ready_for_review` for the current head appeared, the head moved, the
  owner changed/went not-live, the head became covered, a delivery became pending,
  or the cycle already armed a start. **The green-CI verdict must be bound to the
  exact final head SHA in this revalidation snapshot** — not stale check data
  associated with a prior head. If the PR head advanced between the CI snapshot and
  the revalidation, the fast branch **aborts** unless green is re-proven for the new
  final SHA (the report-head-binding class: never start green-only on a head whose
  checks are actually pending/unknown). Residual race (accepted, per #261): a resume
  + push *after* the snapshot reviews the prior green head benignly; the new head
  is uncovered and re-evaluated next tick.
- **"Stable head" is an observable predicate.** "Stable" means the **same PR head
  SHA across the full elapsed-idle window and the pre-run revalidation snapshot** —
  not merely unchanged for one tick. A head that changed at any point inside the
  short-debounce window restarts the idle measurement (the worker is still amending);
  only an unbroken stable-SHA window plus the revalidation makes it fast-eligible.
  The window is measured from a **durable head-stability marker** — a persisted
  per-`(PR, head)` *first-observed-stable-at* timestamp, or an authoritative PR
  head-update timestamp — **not** solely the worker heartbeat (a push during
  reconciler downtime, or a head change that did not bump the heartbeat, must not let
  the debounce elapse against an older idle timestamp on a freshly-changed head). A
  restart/offline fixture where the head changed during downtime asserts the debounce
  restarts from the head-stability marker, not a stale heartbeat.
- **Distinct, auditable reason — stable enum, required fields.** The fast start and
  each fail-closed defer record a **stable, distinct enumerated reason value** (the
  planner chooses the literal strings, but the *set* is closed and tested by value,
  not by loose substring match) such that an operator can tell apart, from the audit
  trail alone: a fast-reengage start, a #261 sustained-quiescence start, a
  report-driven start, a `no_ready_for_review` defer, and each fast-branch
  fail-closed defer (no/ambiguous prior hand-off, ambiguous owner, not-live owner,
  cycle-already-armed, pending delivery, within-debounce, TOCTOU abort). The start
  record carries the **required fields** PR number, head SHA, prior-hand-off
  evidence reference, idle/no-pending-delivery basis, and cycle id; a fixture asserts
  the exact enum value and the presence of these fields, so a test cannot pass on
  loose text while the operator-facing trail stays ambiguous. **Defers are sticky /
  idempotent, not per-tick.** A terminal or fail-closed defer for the same
  `(PR, head, owner, reason)` emits a **new** operator-visible audit event only on
  **first observation or a material state change** — repeated reconciler ticks over
  an unchanged defer do **not** re-emit (no audit spam, operator-alert noise, or
  status churn — the #327-storm class applied to the audit dimension). The
  sticky-defer key **includes the cycle / consumed-review-round id**, and
  "material state change" **includes a cycle/round change** — so a genuinely new
  round that hits the same `(PR, head, owner, reason)` (e.g. a later same-SHA round)
  **does** emit a fresh event rather than being suppressed as "unchanged". A fixture
  asserts one event across many unchanged ticks, and a fresh event on a material
  change **including a new cycle/round at the same SHA**.
- **No CI-green nudge change.** This issue does **not** make a post-hand-off worker
  eligible for the #191 CI-green nudge (that stays skipped per #174). It starts the
  **review** directly — the worker re-engages by receiving review findings (or a
  clean pass), not by being nudged to re-report. No dependency on the worker
  message-delivery transport (`docs/issues_drafts/89-…`); a faster review-start
  needs no delivered nudge.
- **Reads only signals already exposed to the review-trigger reconciler — no edit to
  #89/#216.** Under the v1 consumed-review-run scope, the facts the fast branch needs
  — a terminal **review run** for a prior head (review-run id), the worker's **report
  transitions** (`ao status` / `ao report`), coverage (`ao review list`), and the
  existing #332 `pending_unconsumed_delivery` signal — are all **already read-only
  available** to the reconciler. The fast branch consumes them; it does **not** add a
  new delivery-correlation surface or edit the `89-…`/#216 transport. If any required
  fact turns out **not** to be exposed read-only today, that is a **prerequisite to
  split out**, not a reason to edit out-of-scope transport code.
- **Operator adoption:** none beyond restarting the supervised reconciler if a
  supervised process surface changes; no new env var, no `agent-orchestrator.yaml`
  change, no new go-live process. State the actual restart step (if any) in
  Verification. The short-debounce length is a planner choice bounded by the safety
  invariant; tie it to an existing window where one fits rather than inventing a
  constant.

## Files in scope

- The shipped review-trigger reconciler **eligibility-decision modules** (current
  layout `docs/review-trigger-reconcile.mjs`, `docs/review-head-ready.mjs`, and the
  per-cycle `docs/worker-iteration-cycle.mjs` it already consults), their
  PowerShell drivers (`scripts/review-trigger-reconcile.ps1`,
  `scripts/review-trigger-reeval.ps1`), and any eligibility/coverage helpers under
  `scripts/lib/` they call. These `.mjs` are code helpers despite living under
  `docs/`.
- Their colocated test suites (`scripts/review-trigger-*.test.ts`,
  `scripts/review-head-ready.test.ts`, `docs/worker-iteration-cycle` tests, and any
  eligibility-helper tests).
- Prose documentation of the review-trigger paths only where it already describes
  the handoff gate / review-start fallback.

## Files out of scope

- **The CI-green nudge (#191) post-hand-off carve-out.** Unchanged — no nudge to a
  post-hand-off worker; this issue starts the review instead.
- **#261's general sustained-quiescence branch and its debounce.** Unchanged; this
  issue adds a *shorter* sibling branch gated on prior hand-off, it does not retune
  the existing one.
- **Reviewing a genuinely not-live worker's head** — fails closed here; orphan /
  sessionless review is a separate task (as in #261).
- **The worker message-delivery / nudge transport** (`89-…` / #216 submit
  reconciler). Out of scope: the fast path needs no delivered nudge.
- **The active-but-stuck worker that keeps signalling activity yet never hands
  off** — a distinct worker-stuck-detection class; excluded (active-work guard
  defers it).
- `agent-orchestrator.yaml`, reactions, notifiers, AO-core/`vendor/**`/`packages/core/**`.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

Observable, each provable by a fixture-driven test against representative
orchestrator state (`ao status` / `ao review list` / `gh pr view` shapes captured
from real output, including the PR #344 / opk-34 incident). The enumeration is the
decision's full equivalence-class matrix; each row is a fixture.

Decision: *start a review run NOW (fast branch) for (PR, current head)?* Dimensions
— CI level {**green** (fast-eligible) | defer (red / degraded / unknown /
pending-known)} × head covered {yes | no} × `ready_for_review` for current head
{present | absent} × **prior hand-off bound to current owner** {present | absent /
different-or-unresolvable owner} × owner activity {active |
idle-stable-past-short-debounce | idle-within-short-debounce | pending/unconsumed
delivery | not-live/orphan | ambiguous owner} × cycle state {new cycle opened by a
delivered review round | start already armed this cycle}.

1. **CI-green · uncovered · current-head report absent · prior hand-off present ·
   owner live, idle, stable, no pending delivery, past the SHORT debounce · cycle
   start not yet armed** → **starts** a review run for the current head against the
   live session via the single-winner claim. *(The new fast behavior; the PR #344 /
   opk-34 class — `addressing_reviews` or stale-bound `ready_for_review`, fresh
   green head, idle.)*
2. **Same as 1 but no prior hand-off bound to the current owner** (no prior
   hand-off at all, OR a prior hand-off from a different/unresolvable session, OR
   no earlier head distinct from the current one) → fast branch does **not** fire;
   falls back to #261's normal (longer) quiescence path. Never shortens the guard
   for a never-handed-off first draft and never trusts a stale-ownership signal.
3. **Same as 1 but owner actively working** (mid-turn / head moved within debounce /
   the current round's review-findings delivery is unconsumed) → **defers**
   (unchanged #195 + #332 `worker_actively_working` / `pending_unconsumed_delivery`).
3a. **Same as 1 but a pending delivery bound to this owner/PR cannot be correlated
    to the current round** → **defers, fail-closed** (logged), never a premature
    start; but the defer is **bounded** — it gates only the fast branch, not #261's
    general path, which still starts review after its longer debounce. A fixture
    proves the **unwedge mechanism** (the uncorrelated stale delivery is aged/ignored
    by #261's path after the long debounce, or escalated as an operator-visible
    terminal defer past a finite bound), not just that the next tick re-evaluates.
    Paired fixtures: (i) relevant-round delivery unconsumed → defer (distinct
    reason); (ii) uncorrelated delivery **independently proven stale/terminal/
    old-round** → #261 may start after its long debounce; (iii) uncorrelated but
    **not** proven stale (e.g. a current findings delivery the state surface failed
    to parse) → **finite operator-visible terminal defer**, **not** a start — #261
    does **not** start on the long debounce alone here (reviewing ahead of unconsumed
    findings is the failure being prevented).
4. **Same as 1 but within the short debounce (not yet sustained)** → **defers**;
   becomes row 1 once the short debounce elapses with the head still stable.
5. **Same as 1 but a review start was already armed *within the current* cycle (no
   new review round since)** (`already_reviewed_this_cycle`) → **does not** start a
   second; respects the #332 per-cycle gate.
5a. **A review start exists for an EARLIER head in a PRIOR cycle, findings were
    delivered, and the worker pushed a fresh fixed green head opening a NEW cycle**
    → the fast branch **starts** for the fresh head (the prior cycle's arm must
    **not** suppress it). This is the incident's exact shape and the regression
    guard against the per-cycle gate over-blocking. Fixture: an old-head terminal
    review run + a new cycle opened by the delivered round + fresh green uncovered
    head → starts.
5b. **Cycle rollover fires once, durably — not per tick, and survives restart.**
    After the row-5a fast start, later ticks observing the **same** (prior review
    delivery/run id, PR, new head SHA, owner lineage) conjunction do **not** mint a
    new cycle and do **not** start a second review run; a new fast start requires a
    genuinely new round. Fixtures: (i) multiple ticks after a row-5a start → exactly
    one review run; (ii) **restart/reload** — persist the rollover, stop/restart the
    reconciler, re-run the same fixture → **no** new cycle, **no** second start.
5c. **Rollover does not disturb other #332 latches.** Opening the new cycle for the
    fresh post-review head must **not** reset `already_nudged_this_cycle` or
    `handoffAccepted` so as to re-enable a CI-green nudge or handoff behaviour #332
    suppressed. Regression fixtures assert nudge and `handoffAccepted` behaviour is
    unchanged for same-head and non-fast cases.
5d. **Crash after cycle-open, before claim/latch.** A crash after the new cycle
    persisted but before the review-start claim/latch leaves the cycle open with the
    start **un-armed**; the next tick **starts** (completes the pending start), never
    skips forever and never mints a second cycle. Fixture: persist cycle-open, no
    latch, restart, re-run → exactly one start.
5e. **New round is keyed on a consumed review-round, not head SHA alone — but
    covered-head idempotency still governs the SHA.** A force-push / amend / SHA-reuse
    **after** the same consumed round does **not** open a new cycle (no duplicate
    start); an owner-lineage change with **no** new consumed round does **not** open
    a new cycle (no false start). For a same-SHA case, **row 7 / the per-`(PR, head)`
    claim win:** if that SHA already has terminal coverage or an in-flight claim, the
    fast branch does **not** start (no duplicate, idempotency intact) **even** in a
    later round; the new-round keying only prevents *suppressing* a start for a
    genuinely **uncovered** head, never *forcing* one on a covered head. **The
    distinct-earlier-head prior-hand-off predicate is not waived:** a same-SHA
    later-round start is eligible only when the prior hand-off is still satisfied by a
    separate **earlier head distinct from the current** — a replayed/no-op delivery on
    the same current head is **not** by itself sufficient prior-hand-off evidence.
    Fixtures: same SHA, later round, **already covered** → no start (row 7); same SHA,
    later round, **uncovered, no in-flight claim, distinct earlier hand-off head still
    present** → start; same SHA with **no** distinct earlier hand-off head → fails
    closed; lineage change without a new round → defers.
6. **current-head report PRESENT (bound to current head)** → starts via the
   existing report-driven path (unchanged #195/#207); the fast branch is not
   consulted.
7. **covered (a terminal review run already covers the current head)** → does
   **not** start (unchanged #189 covered-head idempotency).
8. **CI defers (red / degraded / unknown / pending-known)** → does **not** start
   via the fast branch (the fast path is **green-only**; pending-known is left to
   the report-driven/#261 paths under the unchanged #207 contract).
8a. **CI-green verdict not bound to the final revalidated head** — the PR head
    advanced between the CI snapshot and the pre-run revalidation, so the green
    verdict belongs to a prior head while the current head's checks are
    pending/unknown → **aborts** (does not start on stale-bound green). Fixture:
    green for head A, head advanced to B at revalidation, B not proven green → abort.
9. **No live session owns the current head (not-live/orphan owner)** → **fails
   closed**, records "no live review target"; orphan review is out of scope.
10. **Ambiguous/unresolvable owner** (multiple live candidates, or owner not
    resolvable to the current head) → **fails closed**, records a defer reason.
11. **Prior-hand-off evidence ambiguous or absent from authoritative state** →
    **fails closed** for the fast branch (does not assume a hand-off), defers to
    #261's normal path.
11a. **Ownership-lineage binding, both directions.** A prior hand-off reachable
     through a **valid, authoritatively-resolved** respawn/rotation of the current
     owner → fast-eligible (starts). A prior hand-off belonging to a **parallel or
     different live session** with superficially similar PR/head history → **fails
     closed** (must not bind the wrong session). Two fixtures (valid lineage starts;
     look-alike session defers).
12. **Pre-run revalidation (TOCTOU):** state changed between the eligibility
    decision and emission (worker resumed, current-head `ready_for_review`
    appeared, delivery became pending, head moved, owner changed/went not-live,
    head became covered, or the cycle armed a start) → start **aborted**,
    fail-closed, logged.
13. **Idempotency:** repeated ticks over a row-1 PR start **exactly one** review run
    for that head and that cycle; later ticks find it covered/in-flight/armed and do
    not start a second.
13a. **Crash-after-claim recovery (inherits #308):** a claim acquired for the fast
     start whose review run never reached terminal coverage is recovered by #308's
     claim-release-on-terminal-failure — re-evaluated on a later tick, **never**
     duplicated on retry and **never** left permanently uncovered. Fixture: claim
     acquired, review-not-terminal, then a subsequent tick.
14. The fast start is logged with a reason distinct from a #261 sustained-quiescence
    start, a report-driven start, and a `no_ready_for_review` defer — naming PR,
    head SHA, prior-hand-off evidence, idle/no-pending-delivery basis, and cycle id.

```positive-outcome
asserts: a CI-green, uncovered PR whose live owning worker previously handed this PR off, is now idle with a stable head and no pending/unconsumed delivery past the SHORT debounce, has no ready_for_review for the current head, and whose cycle has not yet armed a review start, gets exactly one review run started for that head against the live session
input: external-tool-output
provenance: capture-backed
```

The `capture-backed` fixtures for criteria 1–14 must use orchestrator state shapes
captured from real `ao status` / `ao review list` / `gh pr view` output — including
the PR #344 / opk-34 incident (owner live + idle, head green + uncovered,
`reportState: addressing_reviews` or `ready_for_review` bound to an older head, no
current-head report) and a sibling with **no** prior hand-off (→ row 2). A
plausible-but-impossible state must not satisfy criterion 1 — name at least two
concrete impossible-state negative fixtures that must **fail** criterion 1:
(i) prior-hand-off evidence present but **no live owner lineage** resolves;
(ii) a `ready_for_review` bound to a **stale** head presented as if current; and
(iii) a head simultaneously marked covered and uncovered (coverage/report mismatch).
Rows 2, 3, 3a, 5, 5c, 5d, 5e, 7, 8, 9, 10, 11, 11a, and 12 are the
safety-regression / fail-closed guards; row 5a is the over-blocking regression guard
(the per-cycle gate must not eat the incident case), 5b the durability guard, and
13a the crash-recovery guard.

## Upgrade-safety check

- No edits to AO core, `vendor/**`, or `packages/core/**`.
- No new `agent-orchestrator.yaml` keys, reactions, or unsupported YAML; no new
  operator env var or repository secret.
- No change to what `ao review run` accepts (live sessions only) or to the
  single-winner per-`(PR, head)` claim; the fast branch starts through it.
- The #191 CI-green nudge post-hand-off skip, the #332 per-cycle gate, the #195
  handoff gate, #189 covered-head idempotency, the #207 CI contract, and #261's
  general quiescence branch remain observably intact (rows 2, 3, 5, 6, 7, 8 and the
  #261 fallthrough are regression guards).

## Verification

- A test suite covering acceptance criteria 1–14, each a fixture row of the
  equivalence-class matrix, run as the colocated `*.test.ts` suites pass.
- Rows 2, 3, 5, 7, 8, 9, 10, 11, 12 explicitly assert no-regression / fail-closed
  safety: prior-hand-off required (2, 11), active-work/pending-delivery defer (3),
  per-cycle gate (5), covered-head idempotency (7), CI contract (8), live-target
  only (9), ambiguity fails closed (10), TOCTOU abort (12).
- A reproduction fixture from the PR #344 / opk-34 incident asserts criterion 1
  starts the review against the live owner on the short debounce; the no-prior-
  hand-off sibling asserts row 2 falls back to #261.
- The reconciler's harness demonstrates idempotency (13) across multiple ticks, the
  crash-after-claim recovery (13a) inheriting #308, and the pre-run revalidation
  (12) by mutating state between decision and emission.
- A **restart/reload** fixture (5b-ii) persists the cycle rollover, restarts the
  reconciler, re-runs the same input, and asserts no new cycle and no second start —
  durability, not just single-process idempotency.
- A **persistence-fault** fixture: a torn/partial, empty (fresh-root), and
  stale/incompatible-schema rollover store each resolve via the existing
  mechanical-json-state quarantine + **reconstruction from the primary authorities**
  (`ao review list` coverage + the single-winner claim store; audit is corroborating
  only) before re-arming — asserting covered/claimed → no re-start, uncovered/unclaimed
  → start, signals-disagree/unreadable → terminal operator-visible defer; never a
  duplicate start, never a swallowed start.
- A **restart-across-the-short-debounce-boundary** fixture (F1): reconciler/worker
  restarts near the idle threshold → elapsed-idle is computed from the
  restart-comparable AO last-activity timestamp, so the fast branch neither fires
  immediately nor defers forever nor uses the wrong epoch.
- A **sticky-defer** fixture: many unchanged ticks over the same
  `(PR, head, owner, reason)` emit **one** audit event; a material state change emits
  a fresh one.
- A **supervisor-shape invocation** contract fixture: asserts the supervised driver
  is invoked with the same cwd / inherited env / `PATH` lookup / exit-code surface as
  the running supervised process (no real credentials), so a Windows/Ubuntu quoting
  or env bug cannot pass the isolated harness yet fail only under the supervisor.
- A **composed production-like** fixture (F2-p7): runs the affected `.ps1` **through
  the supervised-driver surface, non-dry-run, with the shimmed `ao`**, at
  production-equivalent cwd/env/`PATH` semantics and credentials **replaced** (not
  inherited) — so the action-producing path is proven end-to-end, not only as two
  separately-passing isolated and contract fixtures.
- An **older-round claim reconstruction** fixture: a per-`(PR, head)` claim exists
  from an older/abandoned round (terminal and non-terminal/pending-#308-release
  variants) → reconstruction does not false-no-start a genuinely uncovered later
  round nor premature-restart during release; the ambiguous case → terminal defer.
- A **live-adoption** assertion: after the documented restart, the supervised
  reconciler actually executes the updated eligibility entrypoint/version (not a
  false deploy-success where tests pass but the live supervisor runs old code).
- A **stale-report-only prior-hand-off** negative fixture (v1 scope): prior-hand-off
  evidence is only a stale-bound `ready_for_review`/post-hand-off report with **no**
  consumed review run → the fast branch is **not** eligible and the PR falls back to
  #261's normal path (no surrogate-identity machinery in v1).
- A **crash-after-rollover-before-claim** fixture (5d): cycle persisted, no latch,
  restart → exactly one start.
- The **new-round keying** fixtures (5e) cover the **full qualified matrix**, not a
  single "same-SHA → starts": (i) same SHA, later round, **already covered / in-flight
  claim** → **no** start; (ii) same SHA, later round, **uncovered, no in-flight claim,
  distinct earlier hand-off head present** → starts; (iii) same SHA with **no** distinct
  earlier hand-off head (replay/no-op) → **fails closed**; (iv) owner-lineage change
  with **no** new consumed round → defers.
- Two **observation-order** fixtures (F4): delivery-consumed-before-head-change, and
  head-change-before-delivery-consumed — each across at least two ticks and one
  restart — prove **exactly one** cycle opens for the intended (consumed-round, head)
  pair and the early-observed half holds rather than opening prematurely.
- **#332 shared-latch regression** fixtures (5c) assert that opening the new cycle
  does not reset `already_nudged_this_cycle` / `handoffAccepted` for same-head and
  non-fast cases — the CI-green nudge and handoff suppression #332 introduced stay
  intact.
- Paired **ownership-lineage** fixtures (11a): a valid authoritatively-resolved
  respawn lineage starts; a look-alike parallel/different live session fails closed.
- A bounded **uncorrelated-stale-delivery** fixture (3a): proves the unwedge
  mechanism (#261 fallthrough after the long debounce, or a finite-bound
  operator-visible terminal defer) — the head is never permanently un-reviewable.
- **PowerShell driver surface exercised, not only the Node logic.** At least one
  verification item runs the affected supervised driver path
  (`scripts/review-trigger-reconcile.ps1` / `review-trigger-reeval.ps1`,
  `-Once -DryRun`) over the same row-1 / row-5a fixture input the Node eligibility
  test uses, so a quoting/path/shell/exit-code difference on the Windows/Ubuntu
  supervised surface cannot pass silently behind a green `.test.ts`. At least one
  such driver fixture must carry **representative Windows/WSL shapes** — backslash
  and `/mnt/` paths, quoted paths with spaces, and CRLF-terminated captured output —
  so the cross-platform failure class this surface is meant to catch is not masked
  by sanitised POSIX-only fixtures. The driver verification is **split into two**:
  (1) a `-DryRun` eligibility check (no invocation), and (2) a **non-dry-run** check
  with a **harmless fake/shim `ao`** that proves the **real** `ao review run`
  command line is actually executed and observed (argument/quoting shape, exit-code
  propagation, claim/audit handoff) without creating a real review run — closing the
  loophole where a dry-run-only check never exercises the action-producing
  invocation. Because that check **is** action-producing, it must be **isolated from
  the real operator environment**: an isolated temp cwd / state root, `PATH` pinned
  to the shim first, real AO/GitHub credentials unset or replaced, and an assertion
  that the **resolved executable path is the shim** — so a harness mistake cannot
  call the real `ao review run` or leak token-bearing env into captured output.
- State the exact supervised-process restart step (if any) for the change to take
  effect in the running supervisor.
- **Planner-discretion alternative (recorded, not mandated).** GPT pass 1 raised a
  lower-bespoke design: instead of a distinct fast branch, synthesize a "current
  head needs review" candidate from the same owner's terminal/prior review-run
  lineage and feed it through the **existing** report-driven start path + claim
  machinery, reducing new eligibility code. It is viable **only** if the code can
  represent synthetic report-absence without weakening the #195 handoff gate or the
  #207 CI contract; if it cannot, the explicit fast branch above stands. A refinement
  (GPT pass 3) of either structure: have the fast branch consume a small **persisted
  "post-review fresh-head review-needed" event** minted once at
  delivery-consumption/new-head detection, turning rollover + eligibility into
  replayable event processing instead of a repeatedly-derived cycle transition —
  this is the event-sourced form of the durable one-time-transition requirement
  above and satisfies it well (one immutable event per consumed review round cleanly
  supplies the round id, rollover, sticky-defer identity, and reconstruction) — but
  it remains the planner's choice. The acceptance criteria bind the *behavior*, not
  the structure.
- **Open questions (record before sync, not in scope):** (a) the active-but-stuck
  worker that signals activity yet never hands off is excluded (row 3 defers) —
  separate worker-stuck task; (b) a genuinely not-live owner's green head (row 9
  fails closed) needs orphan/sessionless review AO does not expose today — separate
  task; (c) the exact short-debounce length vs #261's general debounce is a planner
  choice bounded by the safety invariant — note the chosen basis.

## Decisions (GPT adversarial pass)

Pass 1 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 7 findings —
0 critical / 3 high / 3 medium / 1 low):
- *SHORT debounce unresolved (high)* → **partial**: pinned the debounce *basis*
  (authoritative monotonic elapsed-idle clock, strictly shorter than #261's,
  floored above a minimum > 0) without dictating the constant — planner freedom.
- *Prior-hand-off not bound to current owner (high)* → **accepted**: evidence must
  bind to same PR + same current live owner (or valid lineage) + an earlier head
  distinct from the current; a different/unresolvable-owner signal does not count.
- *Per-cycle gate may block the exact case (high)* → **accepted** (the crux): a
  delivered review round opens a **new** worker-iteration cycle so the
  fresh-fixed-head fast start is not suppressed by the prior cycle's arm; added
  row 5a as the over-blocking regression guard.
- *CI green vs pending-known inconsistency (medium)* → **accepted**: fast branch is
  **green-only**; matrix + rows 1/8 aligned, pending-known defers.
- *Crash-after-claim recovery unvalidated (medium)* → **partial**: bound to #308
  claim-release-on-terminal-failure (no new crash semantics) + added row 13a.
- *Audit reason not schema-stable (medium)* → **partial**: required a closed,
  distinct enum tested by value + required start-record fields; planner picks the
  literal strings.
- *PowerShell driver not exercised (low)* → **accepted**: added a verification item
  running the supervised `.ps1` driver path over the row-1/5a fixture.
- *ALTERNATIVE (synthetic candidate through the existing path)* → **recorded** as a
  planner-discretion option (viable only if synthetic report-absence doesn't weaken
  #195/#207); not mandated — criteria bind behavior, not structure.

Pass 2 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 3 findings —
0 critical / 1 high / 2 medium; ledger held, no relitigation):
- *Cycle rollover could be a per-tick derived reset, not a one-time transition
  (high)* → **accepted**: rollover is a durable, idempotent, one-time transition
  keyed by (prior review delivery/run id, PR, new head SHA, owner lineage); later
  ticks on the same conjunction never re-mint a cycle — added row 5b.
- *Pending-delivery guard not scoped to the relevant round (medium)* → **accepted**:
  scoped to same PR + owner/lineage + the current round's review-findings delivery;
  an uncorrelated owner/PR delivery defers **fail-closed** (premature review is the
  worse failure; #261 is the backstop so it cannot wedge forever) — added row 3a.
- *Capture-backed fixtures may not prove cross-platform paths (medium)* →
  **accepted**: at least one driver fixture must carry Windows/WSL backslash+`/mnt/`
  paths, quoted spaced paths, and CRLF output.
- *ALTERNATIVE (prefer synthetic-candidate)* → unchanged from pass 1: recorded as
  planner discretion; not mandated (criteria bind behavior, not structure).

Pass 3 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 5 findings —
0 critical / 2 high / 2 medium / 1 low; deeper persistence/restart edges, ledger
held):
- *Stale uncorrelated delivery could still permanently defer (high)* → **accepted**:
  the fail-closed defer is now **bounded** — gates only the fast branch, not #261;
  a fixture must prove the unwedge mechanism (#261 fallthrough or finite-bound
  terminal defer), not "next tick"; delivery aging stays #89/#216's scope.
- *Durable rollover not restart-validated (high)* → **accepted**: rollover must
  survive a reconciler restart/reload; added restart fixture (5b-ii).
- *Rollover may reset shared #332 latches (medium)* → **accepted**: rollover scoped
  to the review-start latch; `already_nudged_this_cycle`/`handoffAccepted` regression
  fixtures (5c).
- *"Valid ownership lineage" not operationalized (medium)* → **accepted**: name the
  authoritative lineage source, positive resolution required, paired valid/look-alike
  fixtures (11a).
- *PowerShell `-DryRun` may skip real invocation (low)* → **accepted**: a fake/shim
  `ao` fixture exercises the real shell invocation path.
- *ALTERNATIVE (persisted "review-needed" event)* → **recorded**: the event-sourced
  form of the durable one-time-transition requirement; folded into the
  planner-discretion note, not mandated.

Pass 4 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 5 findings —
0 critical / 2 high / 2 medium / 1 low; FALSE_POSITIVES block confirmed owner-binding,
pending-delivery scope, restart durability, lineage, and shared-latch reset as
materially addressed):
- *Durable rollover lacks persistence schema/atomic boundary; `.ao/**` denylisted
  (high)* → **accepted**: markers use the existing mechanical-json-state discipline
  (atomic write + quarantine-on-corruption) in the reconciler's existing state root,
  no new side file; corrupt/empty/stale-schema fixture.
- *Crash between rollover-persist and claim loses the start (high)* → **accepted**:
  cycle-open and start-armed are **distinct** persisted facts; a crash between them
  leaves the start un-armed so the next tick starts (row 5d).
- *Force-push/amend/SHA-reuse collapses the conjunction (medium)* → **accepted**: a
  new round is keyed on a newly-consumed review-round id, not head SHA alone
  (row 5e).
- *`-DryRun` loophole vs action-producing (medium)* → **accepted**: split driver
  verification — a dry-run eligibility check + a non-dry-run fake-`ao` invocation
  check.
- *"Plausible-but-impossible state" not operationalized (low)* → **accepted**: named
  three concrete impossible-state negative fixtures.
- *ALTERNATIVE (prefer persisted-event if no safe persistence surface)* →
  reinforces the persistence resolution; already recorded as planner discretion.

Pass 5 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 4 findings —
0 critical / 2 high / 2 medium; internal-consistency + test-isolation, ledger held):
- *Same-SHA new-round (5e) contradicts covered-head idempotency + per-head claim
  (high)* → **accepted**: qualified 5e — covered/in-flight SHA never re-starts
  (row 7 / claim win); the new-round keying only prevents *suppressing* an uncovered
  head, never *forces* a duplicate on a covered one.
- *Prior-hand-off evidence may lack the run-id the cycle key needs (high)* →
  **accepted**: defined a durable surrogate round id from a non-run report's stable
  identity (bound head + report id/timestamp), recorded in key + audit.
- *Corrupt-state recovery promises both guarantees without a reconstruction source
  (medium)* → **accepted**: re-derive from authoritative sources (`ao review list` +
  claim store + audit) before re-arming, else terminal defer; claim store prevents
  duplicates so reconstruction is safe by construction.
- *Action-producing fake-`ao` not isolated (medium)* → **accepted**: isolated temp
  cwd/state root, PATH pinned to shim, creds unset/replaced, assert resolved
  executable is the shim.
- *ALTERNATIVE (one mandatory event id per consumed round)* → folded into the
  planner-discretion note as the explicit form of the round-key surrogate.

Pass 6 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 5 findings —
0 critical / 2 high / 3 medium; ledger held):
- *Process-local monotonic clock isn't restart-comparable (high)* → **accepted**
  (corrects an earlier edit): idle basis is the AO-recorded last-activity timestamp,
  restart/respawn-comparable, not the reconciler's process clock; restart-across-
  debounce fixture.
- *Row 5e may waive the distinct-earlier-head predicate (high)* → **accepted**:
  same-SHA later-round starts only if a separate distinct earlier hand-off head still
  satisfies the predicate; a replay on the same head fails closed.
- *Terminal/fail-closed defers not sticky/idempotent (medium)* → **accepted**: defers
  keyed by `(PR, head, owner, reason)`, new audit event only on first observation or
  material change (#327-storm class in the audit dimension).
- *Audit treated as authority without durability rules (medium)* → **accepted**:
  reconstruction's primary authorities are coverage + the claim store (durable via
  #308); audit is corroborating only; disagreement/unreadable → terminal defer.
- *Fake-`ao` isolation may mask supervisor-specific invocation (medium)* →
  **accepted**: added a supervisor-shape invocation contract fixture.
- *ALTERNATIVE (mandate the persisted event)* → **rejected as a mandate** (planner
  freedom; criteria are consistent without it) but kept as the **recommended**
  approach in the planner-discretion note.

Pass 7 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 4 findings —
0 critical / 2 high / 2 medium; verification-completeness + event-ordering, ledger
held):
- *5e verification bullet looser than the qualified criterion (high)* → **accepted**:
  rewrote it to the full four-case matrix (covered/in-flight no-start; uncovered+
  distinct-earlier-head starts; no distinct earlier head fails closed; lineage-change
  defers).
- *Action path + supervisor path validated separately, composed path untested (high)*
  → **accepted**: added one composed production-like fixture (supervised `.ps1`,
  non-dry-run, shimmed `ao`, production cwd/env/PATH, creds replaced).
- *Sticky-defer key omits cycle/round id (medium)* → **accepted**: key includes the
  cycle/consumed-round id; "material change" includes a cycle/round change; same-SHA
  later-round defer emits a fresh event.
- *Rollover specified for final state, not observation order (medium)* → **accepted**:
  rollover robust to snapshot order — opens once both conjunction halves co-occur in
  one snapshot; added two observation-order fixtures across ticks + restart.
- *ALTERNATIVE (persisted event for observation-order)* → unchanged: recommended
  planner discretion.

Pass 8 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 6 findings —
0 critical / 2 high / 3 medium / 1 low; cross-mechanism + binding edges, ledger held):
- *#261 fallback precedence per fail-closed reason undefined (high)* → **accepted**:
  split safety-shared reasons (#261 must also defer, may start only after its own
  fresh stricter revalidation) from fast-ineligibility-only reasons (#261 may start
  on its own predicate).
- *Claim store is per-head, not round-scoped (high)* → **accepted**: reconstruction
  must not read an older-round claim as the current round; store/recover cycle id
  with the claim or treat older-round claims as non-authoritative; ambiguous →
  terminal defer; older-round claim fixture.
- *"Stable head" not operationalized (medium)* → **accepted**: same PR head SHA
  across the full elapsed-idle window + revalidation snapshot; any change restarts
  the measurement.
- *CI-green not bound to the revalidated head (medium)* → **accepted**: green must
  bind to the exact final head SHA; row 8a aborts on stale-bound green
  (report-head-binding class).
- *Non-run surrogate id unstable under report rewrite (medium)* → **accepted**:
  surrogate from immutable/first-seen-persisted identity, else reject non-run
  evidence; surrogate-rewrite fixture.
- *No live-supervisor adoption assertion after restart (low)* → **accepted**: a
  live-adoption check that the supervised reconciler runs the updated entrypoint.
- *ALTERNATIVE (persisted event)* → unchanged: recommended planner discretion.

Pass 9 (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 5 findings —
0 critical / 3 high / 2 medium; the findings converged on the non-run surrogate path,
and the accepted ALTERNATIVE cut it):
- *Non-run surrogate is key material, not a real cycle-open event (high)* +
  *first-seen surrogate recovery conflicts with corrupt-state reconstruction (high)*
  → **accepted via v1 scope cut**: restricted fast eligibility to a **consumed review
  run** (durable review-run id) on a prior head; **dropped** the stale-report-only /
  surrogate path entirely (it falls back to #261). Simpler and safer; still covers the
  `addressing_reviews` incident. Replaced the surrogate fixtures with a stale-report-
  only **negative** fixture.
- *#261 may bypass an uncorrelated-but-not-proven-stale delivery (high)* →
  **accepted**: uncorrelated ≠ stale; #261 bypasses only after the delivery is
  proven stale/terminal/old-round, else a finite operator-visible terminal defer
  (never reviewing ahead of unconsumed findings).
- *Delivery-consumption dependency vs #89/#216 out-of-scope (medium)* → **accepted**:
  under the v1 scope the needed facts (terminal review run, report transitions,
  coverage, existing `pending_unconsumed_delivery`) are already read-only available;
  named that, with a "split a prerequisite" clause if any is not exposed.
- *No durable head-stability clock (medium)* → **accepted**: window measured from a
  persisted first-observed-stable-at / authoritative PR head-update timestamp, not
  the heartbeat alone; restart-during-downtime fixture.
- *ALTERNATIVE (consumed-review-run-only v1)* → **adopted** as above.

Pass 10 / cap (`completed_valid` / `VALIDATION=ok`, NEEDS_ATTENTION, 3 findings —
0 critical / 2 high / 1 medium; all **consistency** gaps created by pass 9's scope
cut, all accepted):
- *Goal still admitted stale-report-only hand-off (high)* → **accepted**: narrowed the
  Goal + positive-outcome to a prior **consumed review run**; report-only is named
  only as a non-fast-eligible fallback.
- *"Consumed review run" conflated with "terminal review run" (high)* → **accepted**:
  defined "consumed" as a terminal prior run **plus** worker re-engagement
  (`addressing_reviews` → produced the current distinct head); a terminal run alone
  (clean pass / failed / non-delivered) does not mint a cycle or license a start.
- *Row 3a stated #261 eventual start too broadly (medium)* → **accepted**: rewrote
  row 3a — #261 starts only with independent stale/terminal/old-round proof;
  uncorrelated-but-not-proven-stale → finite operator-visible terminal defer.

**GPT loop: 10 passes; stopped because cap-10; last-pass accepted=3; final
STATE=completed_valid VALIDATION=ok pass=04beb8de-c6c9-428d-ad4c-b3ef22c7f84e
sha=45cecf287b0b40a5ce2d69b851c86e8adeb54bff0134b132f324deb9febb40eb.** Trajectory:
findings 7→3→5→5→4→5→4→6→5→3, never reaching 0 but shifting decisively from
design holes (passes 1–4) through persistence/ordering precision (5–8) to a major
safety **simplification** at pass 9 (v1 restricted to a consumed review-run;
stale-report-only/surrogate path dropped to #261) and consistency cleanup at the cap.
The three **pass-10 fixes above were applied after the final reviewed pass** (the
`sha=` binds to the pre-fix draft), so they are **not themselves adversarially
re-reviewed** — all three are well-bounded fail-closed consistency tightenings of the
pass-9 scope cut; an 11th pass was disallowed by the 10-pass cap. **Still-open as
explicit risk:** the loop closed by cap, not by a zero-accept pass — the standard
architect `codex review` (the separate, mandatory non-GPT pass) has **not** yet run
on this draft and is the next step before/at sync.
