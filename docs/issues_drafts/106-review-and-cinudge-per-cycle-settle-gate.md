# Review-trigger and CI-green nudge must arm per worker-iteration cycle, not per commit

GitHub Issue: #332

## Prerequisite

- `docs/issues_drafts/67-orchestrator-review-gate-on-handoff.md` (GitHub **#195**,
  merged) — defined the handoff gate: a new review round starts only after the worker
  hands the **exact current head** off (`ready_for_review` + CI contract), which
  blocks review on a *non-handed-off* intermediate commit. This draft **re-uses** that
  predicate and **extends** it: #195 gates one head at a time and is satisfied by
  **every** legitimate re-handoff, so a worker that re-hands-off after each fix commit
  passes #195 each time and still draws a fresh review per commit. This draft adds the
  missing **per-PR, per-cycle** layer #195 does not provide.
- `docs/issues_drafts/65-orchestrator-no-rereview-covered-head.md` (GitHub **#189**,
  merged) — the covered-head predicate (`clean`/`needs_triage`/`waiting_update` +
  in-flight = covered). **Re-used verbatim**, not redefined. It dedupes the **same**
  head; it does not dedupe a worker's **sequence of distinct heads** within one fix
  cycle — that gap is this draft.
- `docs/issues_drafts/85-review-trigger-terminal-worker-fallback.md` (GitHub **#261**,
  merged) — the quiescent-handoff fallback and the **15-minute quiescence debounce**
  (`QUIESCENCE_DEBOUNCE_MS`) for a green head whose worker went idle without handing
  off. **Re-used and extended:** the debounce currently bounds only the *quiescent
  fallback* review path; this draft extends the same settle concept to (a) the
  `ready_for_review` review path and (b) the CI-green nudge path, neither of which has
  any debounce today. #261's fallback is **retained**, but placed under the same
  per-cycle gate so it cannot re-arm per intermediate head either.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub **#205**,
  merged) — the supervisor that owns the review-trigger reconcile and the CI-green
  worker-wake reconcile as registered children. Both surfaces this draft constrains
  run **inside** those existing supervised children; the supervisor itself is
  unchanged.
- Review-finding delivery-confirm machinery (the worker-delivery / consumed-marker
  signal that `review-finding-delivery-confirm` and the trigger reconciler already
  read to decide whether a dispatched message was consumed). **Re-used** as the
  observable signal for "prior review revision still being addressed"; this draft does
  not redefine the delivery ledger. **Precondition (must be checked first):** the gate
  needs consumed-matching scoped to the **exact** review revision/delivery. The
  implementation MUST first verify the current delivery-confirm record already carries
  that revision/delivery identity. If it does, the ledger is re-used read-only. If it
  does **not** (the signal is only PR/head/session-level), the **minimal** change to
  expose the revision identity is pulled into scope — a **read/key** change if the
  producer already records it, or a **minimal producer/schema/migration** change if the
  producer must start emitting it (a read-only fix against a coarse producer is not
  acceptable). The gate must not be shipped against a coarse signal that lets revision
  N-1's consumed marker drain revision N (a premature-review false-drain).

## Goal

Stop the orchestrator from re-arming a review run **and** a "CI is green" worker
nudge on **every** commit a worker pushes. A worker that legitimately iterates —
fixing CI, addressing review findings — advances the PR head on each commit; today
both the review-trigger reconciler and the CI-green worker-wake reconciler key their
idempotency on `(PR, headSha)`, so each new head is treated as a fresh, independent
unit of work: a fresh review revision and a fresh nudge. The result is a storm of
review revisions and nudges that pile into the worker's inbox faster than it can drain
them (one observed PR drew ~8 review starts and ~10 CI-green nudges to one worker over
a few hours, interleaved with the worker still addressing earlier findings). The
outcome must be: both surfaces arm at most once per **worker-iteration cycle** for a
PR — gated on the worker having **settled** and on **no prior review revision still
being addressed** — not once per commit/head; and the CI-green nudge is not delivered
to a worker that is **actively working** (it is noise — the worker is not idle).

```behavior-kind
action-producing
```

## Binding surface

This issue commits the repository to the following contracts. The planner picks the
concrete mechanism (shared settle predicate, debounce/cooldown store, consumed-signal
read); the binding requirement is the observable behavior below.

- **The shared per-cycle state machine is defined first; both consumers build on
  it.** This draft's foundational contract is a single, explicitly-specified
  **worker-iteration cycle** state machine for a `(repo, PR)`; the review-trigger
  gate and the CI-green nudge gate are two consumers of it and MUST NOT each invent
  their own notion of "cycle". The cycle has a **deterministic, crash-durable
  identity** and an explicit transition contract the implementation must define and
  test:
  - **Start / open:** when a worker becomes the head-owner of the PR and begins (or
    resumes) work — the first observable iteration after a fresh assignment or after
    a prior cycle closed.
  - **Advance (no re-arm):** a head SHA advancing while the same cycle is open is an
    *intra-cycle* event — it updates the tracked current head but does **not** open a
    new cycle and does **not** re-arm a review or nudge.
  - **Two distinct state domains — do not conflate them.** (a) The **PR-scoped
    review-revision lock** tracks an open review→fix round; it is keyed on the PR (not
    the worker) and survives a worker ownership change. (b) The **owner-scoped
    cycle/nudge/fallback cooldown** tracks one worker's settle/nudge state; it may reset
    on reassignment. "Cycle close" (owner-scoped) does **not** imply "review-revision
    lock release" (PR-scoped).
  - **Close / reset (not on review-armed alone):** arming a review does **not** by
    itself release the review-revision lock. The lock holds from the moment a review is
    **planned/started**. This closes the gap between "review armed" and "findings
    dispatched": a head advance or re-handoff in that window must **not** arm a second
    review while the lock is held. The **review-revision lock releases** when the
    revision reaches a terminal outcome — **exactly one of**: (a) the run completed
    **clean / no-findings** (covered-terminal with nothing to address — there is no
    consumed marker or re-handoff to wait for, so the lock releases **immediately**;
    otherwise a clean review would defer all later cycles forever); (b) findings were
    delivered **and drained** (consumed + post-fix settled re-handoff); (c) the run
    terminal-`failed`/`cancelled`/escalated (per the existing #60/#98 retry bound); or
    (d) the PR left the active set (merged / closed). A **worker ownership change does NOT
    release or drain an open review-revision lock** — the open revision is
    transferred/adopted by the new owner or escalated; releasing it on reassignment
    would abandon unaddressed findings and let the new owner start a fresh review on
    false progress. Owner reassignment **may** reset the owner-scoped cycle/nudge
    cooldown, but not the PR-scoped revision lock.
  - **Ownership change:** when the head-owning worker changes (worker killed +
    respawned, session-id rotation, reassignment), the cycle identity must follow the
    `(repo, PR)` + current owner deterministically — a new owner does not silently
    inherit a stale "already armed/nudged" state that suppresses its first legitimate
    review/nudge, nor does it reset state in a way that duplicates one.
  - **Owner resolution is a fail-closed live-source contract.** The cycle/nudge state
    binds to **exactly one** authoritative current head-owner. When live sources show
    **no** owner, **multiple** plausible owners, a stale session-id rotation, or a
    conflicting owner/worktree mapping, owner resolution **fails closed** (re-using the
    existing owner-resolution / `failClosed` machinery): no nudge is bound to a guessed
    worker and no owner-scoped cooldown is reset, with a distinct recorded reason —
    rather than binding the action to the wrong worker while still claiming the cycle
    key is deterministic. (PR-scoped review-revision-lock state, being PR-keyed, is
    unaffected by an unresolvable owner.)
  - **Crash recovery:** cycle state has one durable source of truth (the runtime
    state store below); after a reconciler/supervisor restart the cycle is rebuilt
    from that store + live `ao status`/`ao review list`, never from in-process memory.
  The planner picks the concrete key fields and store shape; the binding requirement
  is that these five transitions are deterministic and survive restart. The
  per-`(PR, head)` covered-head dedup (#189) and start claim (#267/#308) remain, but
  are **necessary, not sufficient**: a new head is a new key for both, yet must not
  be a new arming opportunity while the cycle is open.

- **CI-green nudge is suppressed while the worker is actively working.** The nudge's
  purpose is to prompt a worker that has gone **idle pre-handoff** (finished, but did
  not report `ready_for_review`) — not to interrupt a worker that is still working.
  The nudge path must consume the **same** "actively working / streaming / recently
  active" signal the review-trigger quiescent path already uses (re-used, not a second
  definition): when the worker is streaming a turn, has an unconsumed pending
  delivery, or is within the quiescence debounce of recent activity, **no** nudge is
  delivered. A nudge arms only for a worker that is pre-handoff **and** settled
  (idle past the debounce on a stable head) **and** has not already been nudged for
  this iteration cycle. This holds **regardless of CI transitions**: a CI red→green
  flip on an actively-working worker does **not** override the suppression (the flap
  coalescing is asserted only on a settled-idle worker, never a working one).
  **A nudge is also suppressed whenever a prior review revision for the PR is open**
  (the review-revision lock is held) — even if the worker appears quiescent/idle:
  prompting "CI green / hand off" while the worker is mid-fix on an open revision
  pressures a premature handoff and re-introduces churn. The nudge is the single-action
  lost-handoff prompt **only** for a cycle with **no** open review revision.

- **A stale unconsumed pending delivery does not suppress the nudge forever.** Treating
  an unconsumed pending delivery as "active work" is correct only while it is fresh; a
  pending delivery that never consumes can be a crashed/stale-session symptom. The
  nudge suppression branch carries the **same bounded backstop** the review
  open-revision state has: past a bound, the pending-delivery condition is re-derived
  from live worker/session state and either cleared (the worker is genuinely idle →
  the one nudge may arm) or escalated — never an indefinite silent suppression that
  starves the worker of its CI-green prompt.

- **Exactly one action per settle — nudge and #261 fallback are mutually exclusive.**
  A single settled-idle pre-handoff condition (worker finished, never reported
  `ready_for_review`, green head) is the trigger for **both** the CI-green nudge
  ("hand off") and the #261 quiescent fallback review ("review the idle head without a
  handoff"). These must **not** both fire from the same settle event — doing so wakes
  the worker (nudge) to advance the head while a fallback review starts on the *old*
  head, recreating the stale-head churn this draft removes. The precedence is binding:
  **the nudge is the primary action first** (prompt the worker to hand off); the #261
  fallback review fires **only after** the nudge's bounded expiry elapses with **no**
  resulting handoff. While a nudge is outstanding, the fallback is held; once a
  fallback review is planned/started for the cycle, the nudge is suppressed. The precise
  invariant: **no two action-producing side effects from the same settle evaluation**
  (never nudge **and** fallback together) — the fallback is the **sequential successor**
  to an expired nudge within the cycle, not a concurrent second action; and there is
  never a second **nudge** in the cycle. Over one cycle the sequence is at most {one
  nudge} then optionally {one fallback after its expiry}, never both at once and never
  two nudges. **The fallback-after-expiry
  revalidates a fresh live snapshot** before it launches — same head-owner, current PR
  head, required CI still green, worker still quiescent past the debounce, no open prior
  revision, and no newer handoff — so a head advance, ownership change, or CI change
  during the outstanding-nudge window does not let the fallback review a stale settled
  head. If revalidation fails (worker became active again, CI temporarily red, source
  stale), no fallback launches and the cycle enters an explicit, durable
  **nudge-expired-fallback-pending** state: the expired nudge does **not** re-arm a
  second nudge, and a later tick that finds the worker idle/green again produces the
  **fallback/escalation** (never a second nudge, never silent suppression). The
  no-co-fire invariant holds across the deferral: nudge and fallback never fire from
  the same evaluation; the fallback is the sequential successor to the unanswered nudge.

- **CI-green nudge fires at most once per cycle (total, not merely "outstanding"),
  flap-resilient.** The nudge must not re-fire on each new head within one cycle, nor
  on each CI red→green flip (`greenEpoch` increment) for the same PR/worker while the
  cycle is open. The invariant is **at most one nudge total per worker-iteration
  cycle** — not just "no two simultaneously outstanding". A nudge that expires with
  **no** resulting handoff does **not** re-nudge in the same cycle (which would become
  a periodic re-nudge loop on an idle-but-not-handing-off worker); per the
  single-action precedence below, the next action after nudge expiry is the **#261
  fallback review**, not a second nudge. A second nudge arms only after the current
  cycle has reached a **terminal close event** and a genuinely new cycle has opened.
  The terminal close events are **exactly**: a worker handoff (`ready_for_review`
  accepted), a review/fallback reaching its terminal-and-drained state, a worker
  ownership change, or the PR leaving the active set. **A head advance + re-settle
  alone does NOT close a nudge-only cycle** — an idle worker pushing commit bursts
  without handing off stays in the same cycle and is never re-nudged (this is the exact
  per-commit re-nudge loophole this draft closes). A mere new commit or CI flap neither
  clears nor re-arms.

- **Review-trigger does not open a new review revision while a prior revision is
  still open — and "addressed" is not "consumed".** When a review revision's findings
  for a PR are **planned/started**, that revision is **open** from that moment (not
  only once findings are dispatched — see the review-revision lock above), and stays
  open until the worker both (a) has consumed the dispatched findings **for that exact
  revision** (the re-used delivery-confirm signal, matched to the revision/delivery
  identity — a stale consumed marker for an **earlier** revision must **not** drain a
  later one — a *necessary* condition) **and** (b) has produced an explicit **post-fix
  re-handoff** (`ready_for_review`) on a **settled** new head after addressing them.
  Delivery-consumption alone is **not** sufficient — reading
  findings is not fixing them — so the gate must **not** open the next revision on a
  consumed marker; it opens only on the post-fix settled re-handoff. While the
  revision is open (worker `addressing_reviews`, or findings dispatched-not-consumed,
  or consumed-but-no-settled-re-handoff-yet), the trigger **defers** a new review
  revision for that PR — even on a newer uncovered, CI-green, `ready_for_review`
  head — and records a deferral reason naming the open revision. This collapses the
  revision queue to at most one open review revision per PR at a time. A **lost or
  delayed** consumed marker must not suppress forever: the open-revision state is
  bounded by the liveness backstop below (it is re-derived from live worker state each
  reconcile tick, and a stuck-open revision past a bound escalates rather than
  silently starving review).

- **Settled-head debounce on the ready_for_review path too.** Even a clean handoff
  must coalesce a burst of rapid commits: when the head is advancing within the
  quiescence debounce window, the review start **waits** for the head to be stable for
  the debounce before launching — so a worker that pushes several commits then hands
  off is reviewed **once** on the final settled head, not once per intermediate head.
  The debounce value and store are the **existing** #261 ones, applied to this path;
  not a new timer. **Post-debounce, the start re-validates that the accepted
  `ready_for_review` identity matches the final current head** (re-using #195's
  exact-current-head handoff guarantee): if the head advanced **after** the handoff
  (worker reported ready on H2 then pushed H3 with no new handoff), the review does
  **not** launch on the stale-handoff head — it defers until a fresh `ready_for_review`
  for the current head. "Final settled head" never means "review a head the worker
  never handed off."

- **Liveness is state-derived, not event-driven — no dropped reviews or lost
  handoffs.** "Head settles", "prior revision drains", and "debounce expires" are
  **not** GitHub or AO wake events; the fix must not depend on one firing. Liveness is
  guaranteed by the **existing periodic reconciler (#163)**: every tick re-derives
  cycle state, debounce expiry, and open-revision drain from live `ao status` /
  `ao review list` / the consumed signal, and arms exactly one review/nudge the first
  tick the blocking condition has cleared — so a deferred PR is serviced within one
  reconcile interval of the condition clearing, with **no new commit required** to
  wake it. The contract binds that the periodic tick **re-inspects** per-cycle /
  debounce / open-revision / consumed state (not only head coverage), and the #235
  re-eval window is a latency optimization, not the liveness guarantee. A worker that
  genuinely finished and went idle pre-handoff still receives its **one** settle
  action — resolved by the single-action precedence below (the nudge first; the #261
  quiescent fallback only after the nudge's bounded expiry with no handoff), **never
  both** from one settle. The fix must not trade a nudge/review storm for a **silently
  starved** review or a worker left idle forever without its one prompt.

- **Required live sources fail closed.** Cycle/debounce/open-revision/consumed state is
  re-derived from multiple live sources (`ao status`, `ao review list`, the consumed
  signal, PR head state). When any **required** source for a decision is missing,
  stale, partially unreadable, or internally inconsistent, the reconciler must **fail
  closed**: it does **not** arm a review or nudge on incomplete state, does **not**
  clear an open-revision / stale-delivery / cycle record on an unreadable snapshot, and
  records a **distinct** defer/escalate reason (read-error=unknown, per the #235
  principle already used for unknown review-list rows and the existing
  fences-untrusted handling). The deferred decision is retried on a later tick once the
  snapshot is healthy, or escalated past a bound — so a transient source outage neither
  arms a wrong action nor silently suppresses forever. **"Stale" must be a defined
  contract per required source**, not left to implementation taste: each source carries
  a freshness/version/head binding (e.g. the snapshot's head SHA matches the PR's
  current head, a record's version/timestamp is consistent with the others), a maximum
  acceptable age where one applies, and a named escalation bound when freshness cannot
  be proven — so one implementation cannot arm on an old-but-readable snapshot while
  another suppresses forever, both claiming compliance.

- **Arming state transitions atomically and is crash-recoverable.** The
  review-trigger child and the CI-green-wake child can observe the same PR within the
  same window, and either can crash between deciding and acting. The per-cycle arming
  record must transition through explicit, recoverable phases — **planned →
  delivered/started → cleared/drained** — so that: a crash *after* deciding but
  *before* the `ao send` / `ao review run` does **not** leave the cycle marked armed
  for an action that never happened (which would suppress the real one), and a crash
  *after* the side effect but *before* recording does **not** allow a duplicate on
  resume. This re-uses the **existing** machinery, not a new one: the per-starter
  **side-effect fence/lock** (already serializing `ao send` / `ao review run`) and the
  CI-green **dispatch journal / pending-journal** replay that already records
  delivered-but-unjournaled nudges. The contract is that cycle-arming records obey the
  same fenced, journal-backed, replay-on-restart discipline these surfaces already
  use — concurrent children and restarts converge to "exactly one armed action per
  cycle", never zero (starved) or two (storm).

- **Every defer/suppress branch is auditable, with deterministic multi-blocker
  precedence.** Not only the prior-revision-open deferral: a durable, operator-visible
  decision reason is recorded for **each** suppress/defer branch — unsettled-head
  debounce wait, busy-worker nudge suppression, prior-revision-open, already-nudged-
  this-cycle, already-reviewed-this-cycle, CI-red defer, and cycle-open intra-advance.
  When **more than one** blocker applies at once (e.g. streaming **and** debounce-
  pending **and** prior-revision-open), the record must be deterministic: it carries a
  **binding precedence** — the **most durable** blocker governs the recorded primary
  reason **and** the next-wake condition (a transient blocker like debounce-pending must
  not mask a durable one like prior-revision-open, or operators/tests will wrongly
  expect a review after the debounce while the revision lock still holds) — and it
  records the full set of active blockers, not only one. This re-uses the reconcilers'
  existing skip / decision-record logging (the same `skip … record={…}` shape the
  trigger already emits). Intra-cycle suppress/defer records are coalesced per
  **`(PR, cycle, branch)`** (preserve first_head / last_head / count), **not** per
  `(PR, head, branch)` — a long fix cycle with many head advances must not emit one
  durable record per head per branch (that recreates the very context/log growth this
  draft removes); per-head records are reserved for **action-producing or terminal**
  decisions only.

- **Every timer is a named, tested bound.** The settle/debounce/expiry/backstop values
  this draft relies on — the settled-head debounce, the nudge bounded-expiry, the
  open-revision stuck bound, the stale-pending-delivery bound — are **binding
  behavior**, not free implementation detail: they decide whether the system starves,
  races the worker, or escalates. Each MUST be a **named constant or named config
  default** (re-using the existing #261 `QUIESCENCE_DEBOUNCE_MS` where the semantics
  match), with a sane documented relationship (e.g. nudge-expiry ≥ the settle
  debounce so a worker is not declared lost before it could settle), and each MUST have
  tests for **below-bound suppression** and **after-bound escalation/fallback**. A spec
  that leaves a timer unnamed (one implementation picks seconds and races, another
  picks hours and starves, both "compliant") is rejected.

- **Per-cycle state is bounded, surface-keyed, and not committed to the repo.** Any
  per-`(PR, worker, cycle)` arming/cooldown record this introduces lives in the
  existing orchestrator runtime/state directory (the same place #261 debounce and #267
  claim state live), **not** in `.ao/**` and **not** committed. Because this draft
  applies the **same** debounce/settle concept to **three** distinct uses — the #261
  quiescent fallback (existing), the `ready_for_review` review-start debounce (new),
  and the CI-green nudge (new) — the record key MUST carry an **action/surface
  discriminator** so the three uses cannot collide in the shared store (a fallback
  debounce record must not suppress a clean-handoff review start, nor a nudge record
  appear as review-settled state). Expanding the store's meaning requires either a
  namespaced/discriminated key or a defined migration — re-using the #261 value/timer
  is fine; silently overloading its key is not. The state directory and all keys must
  resolve to **one canonical identity across Ubuntu and Windows/WSL** for the same
  GitHub PR/head/worker (canonical repo identity + normalized worktree identity), so a
  `C:\…` vs `/mnt/c/…` path split cannot fork the store into two and let restarted
  children duplicate-arm or false-suppress. State is bounded (no unbounded
  per-head append stream) and carries no secrets, no raw prompt/context, no
  environment values.

This change touches the orchestrator-side review-trigger and CI-green-wake reconcile
behavior (supervised children), so:

- **Operator adoption.** This gate lives in **long-running supervised children**
  (the review-trigger and CI-green-wake reconcilers), so adoption is required **even
  when no YAML/env surface changes**: live children keep running the **old** reconcile
  code — and keep producing per-head nudges/reviews — until restarted. The operator
  must restart the affected supervised children (`ao stop` / `ao start`, or the
  supervisor restart path) after the PR merges, and additionally merge any
  `orchestratorRules` / `agent-orchestrator.yaml.example` / debounce-knob change into
  the live (gitignored) `agent-orchestrator.yaml`. The PR's verification section
  states the exact adoption steps and a **live** confirmation — from the running
  reconcilers after restart — that a mid-cycle head advance no longer produces a
  second nudge/review (a code-merged-but-not-restarted runtime must not be mistaken
  for an adopted one).

## Files in scope

- The review-trigger reconcile decision path (the head-ready evaluation and its plan
  step) — extended with the per-cycle / prior-revision-open / settled-head-debounce
  gate.
- The CI-green worker-wake reconcile decision path — extended with the
  actively-working suppression and per-cycle nudge coalescing.
- The shared settle / quiescence signal already used by the review-trigger quiescent
  fallback (re-used by the nudge path; extended, not duplicated).
- **A shared canonical cycle-state / key-resolution surface** — both reconcilers must
  resolve the cycle/debounce/nudge record identity (canonical repo + normalized
  worktree, surface-discriminated keys) and any state-key **migration** through **one
  shared source of truth** so the two consumers cannot diverge under Windows/WSL path
  forms. The planner picks the form (shared module/API, generated table, or equivalent
  abstraction); the binding requirement is the observable outcome — **no per-child
  duplicated path-normalization that can drift** — not a specific function.
- **The delivery-confirm read path, only if the existing record is not already
  revision/delivery-exact** — the gate requires consumed-matching scoped to the exact
  review revision (a stale N-1 marker must not drain N). The existing delivery-confirm
  **ledger schema is otherwise out of scope**; in scope is whatever **minimal read /
  key change** is needed so the gate can match consumed state to the revision identity,
  iff the current record does not already carry it. If the **producer** does not write
  the revision/delivery identity (so a read-only change cannot make the signal
  revision-exact), the **minimal producer/schema/migration change** to emit that
  identity is in scope — a read-path-only fix against a coarse producer is not
  acceptable (see Prerequisite precondition). **Denylist-conflict blocking outcome:** if
  the only producer that could emit the revision identity lives under a **denied** path
  (`packages/core/**` / `vendor/**` — upstream AO), this gate PR MUST NOT proceed by
  violating the denylist or by shipping against a coarse signal; instead it **depends
  on a prior upstream/core issue** that adds the identity (or stops before changing the
  gate). Fail closed, not "ship the weaker gate".
- Tests / fixtures for the scenario matrix below.

## Files out of scope

- The covered-head **predicate** (#189) and the start **claim** mechanics
  (#267/#308) — re-used, not redefined.
- The quiescence **debounce value / store** (#261) — re-used, not re-timed.
- The wake-listener (#207) and the supervisor (#205) — unchanged.
- The review-finding delivery-confirm ledger — out of scope **only after** the
  precondition proves the record already carries revision/delivery-exact identity (then
  re-used read-only). If the producer emits only coarse PR/head/session markers, the
  **minimal producer/schema/migration** change to add the revision identity is **in**
  scope (Files in scope) — it is not waved off by this line.
- Upstream AO internals — `ao review run`, `ao send`, the `ao report` verbs
  (`vendor/**`, `packages/core/**`).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

- A worker that advances the head `H1`→`H2`→`H3` within one iteration cycle (still
  fixing CI / addressing findings, not a clean settled handoff per cell) draws **at
  most one** review run and **at most one** CI-green nudge across the whole burst —
  not one per head.

  ```positive-outcome
  asserts: after a worker settles (head stable past the quiescence debounce, no prior review revision still being addressed, fresh ready_for_review), the review-trigger starts exactly one review run on the final settled head
  input: realistic
  ```

  ```positive-outcome
  asserts: when the head-owning worker is pre-handoff and settled idle (not streaming, no unconsumed pending delivery, past the debounce) on a green head, the CI-green path delivers exactly one nudge for that iteration cycle, given the real ao status / session shape
  input: external-tool-output
  provenance: capture-backed
  ```

- The CI-green nudge is **not** delivered when the head-owning worker is actively
  working — streaming a turn, status actively-working with non-idle activity, within
  the quiescence debounce of recent activity, or carrying an unconsumed pending
  delivery. (Negative-outcome control: a busy worker receives no nudge.)
- The CI-green nudge does **not** re-fire on a new head SHA within the same iteration
  cycle, nor on a CI red→green flip (`greenEpoch` increment) for the same PR/worker
  while the worker is mid-cycle — **at most one nudge total per cycle** (not merely one
  outstanding at a time): a nudge that expires with no handoff escalates to the #261
  fallback per the single-action precedence, it does not re-nudge in the same cycle.
- While a prior review revision's findings for a PR are **dispatched but not yet
  consumed/addressed** (worker in `addressing_reviews`, or findings not
  delivery-confirmed-consumed), the review-trigger starts **no** new review revision
  for that PR — even on a newer uncovered, green, `ready_for_review` head — and
  records a deferral reason naming the open prior revision.
- After the worker **drains** the prior revision (findings consumed) and re-hands off
  on a settled head, exactly **one** next review revision arms — proving the defer is
  eventual, not permanent.
- A burst of rapid commits followed by a clean handoff is reviewed **once** on the
  final settled head: while the head is advancing within the debounce window the start
  waits; once stable for the debounce, one run arms (the settled-head debounce on the
  ready_for_review path).
- The #261 quiescent fallback still fires **once** for a genuinely idle pre-handoff
  worker on a settled green head (no regression: a real lost-handoff still gets its
  review), but does not re-arm per intermediate head within a cycle.
- Deferred/coalesced PRs are eventually serviced: a review deferred for an open prior
  revision or an unsettled head is re-evaluated and arms exactly one run once the
  blocking condition clears, via the existing #163 reconciler / #235 re-eval — no
  silently dropped review.
- **Scenario matrix (representative binding cells — in-body).** The decision axes are:
  D1 head advanced since last action; D2 worker report state; D3 required CI level;
  D4 worker activity (actively-working/streaming vs quiescent<debounce vs
  quiescent≥debounce); D5 prior review revision on the PR (none / open / drained). The
  **general decision rules are the Binding-surface contracts above** (cycle machine,
  busy-suppression, prior-revision-open, single-action precedence, fail-closed
  sources); they govern **every** D1×D2×D3×D4×D5 combination. The table below is the
  set of **representative cells, one per equivalence class** (not the full Cartesian
  product) — every other combination resolves by the Binding contracts and must reduce
  to one of these classes. The cells are inlined so the acceptance spec is
  self-contained and source-controlled (the `/tmp` RCA annex is provenance only). Each
  row is a fixture:

  | # | D1 head | D2 report | D3 CI | D4 activity | D5 prior rev | review-trigger | ci-green-nudge |
  |---|---------|-----------|-------|-------------|--------------|----------------|----------------|
  | C1 | no | ready_for_review | green | quiescent≥deb | none | **start one** | suppress (handed off) |
  | C2 | yes | addressing_reviews | green | working | open | **defer** (rev open) | **suppress** (busy) |
  | C3 | yes | ready_for_review (re-handoff) | green | quiescent≥deb | open | **defer** until prior rev drained | suppress (handed off) |
  | C4 | yes | ready_for_review | green | streaming | open | **defer: prior-revision-open primary** (streaming/debounce secondary) | **suppress** (busy) |
  | C5 | yes | none/sha-less | green | quiescent≥deb | open | #261 fallback **held** (rev open) | suppress |
  | C6 | yes (CI flap r→g) | working | green | **working** | none/drained | n/a | **suppress** (worker working) |
  | C6b | no | working→idle | green (flapped r→g→r→g) | quiescent≥deb | none | (settled-idle path, see C8) | **one** nudge total across flaps, not per `greenEpoch` flip |
  | C7 | yes | working | red | working | none/drained | defer (ci_red) | suppress |
  | C8 | no | working→idle | green | quiescent≥deb | none | nudge **first**; #261 fallback **only after** the nudge expires unanswered — **never co-fired** with the nudge from one evaluation | **nudge once**; suppressed once the fallback is planned/started; never a second nudge |
  | C9 | yes | none | green | quiescent<deb | none | defer (debounce pending) | suppress (debounce pending) |
  | C10 | yes | ready_for_review (post-fix) | green | quiescent≥deb | **drained** | **start one** (the open→drained→next-review transition) | suppress (handed off) |
  | C11 | yes | ready_for_review | **red** | quiescent≥deb | none/drained | defer (ci_red) | suppress |
  | C12 | **no** | addressing_reviews | green | working | open | defer (rev open) | suppress (busy) |
  | C13 | yes | working | green | **working** | drained | defer (worker still active) | suppress (busy) |

  C11–C13 are the representative cells for the combinations GPT flagged as otherwise
  uncovered (ready_for_review+red CI; no-advance+prior-rev-open; drained+still-active);
  each reduces to an existing Binding rule (CI-red defer, prior-rev-open defer,
  busy-suppression). **The matrix must be derived from the single decision table**
  (the cycle state machine + its derived review/nudge/fallback decision rules) so a
  cell cannot drift from the Binding contracts — each row's primary-blocker / action
  is the output of the same decision logic, not a hand-maintained value (this is how a
  C4-style contradiction is prevented structurally, not by review vigilance). C2–C6
  are the sibling cells that share the root cause (the storm today); C1/C8/C10
  prove the gate still arms **exactly one** action on a real settle (no
  over-suppression of the open→drained→next-review transition), C6/C6b prove
  flap/working suppression, and C7/C9 prove it does not under-suppress. **C8 precedence
  is binding:** a single settled-idle pre-handoff condition must **never co-fire** a
  #261 fallback review **and** a nudge from the same evaluation — the nudge is first and
  the fallback is its sequential successor only after the nudge expires unanswered (and
  never a second nudge) — see the precedence contract in **Binding surface**. The fuller RCA derivation with the
  "today vs desired" delta lives at
  `/tmp/orchestrator-pack-review-storm-scenario-matrix.md` (provenance, non-binding).
- Closed-sibling no-regression cross-check: #189 (same-head dedup), #195 (handoff
  gate), #261 (quiescent fallback + debounce), #267/#308 (start claim) stay green.

## Upgrade-safety check

- No edits to AO core or `vendor/**`; the `ao review run` / `ao send` / `ao report`
  verbs are not modified — the gate lives in pack-controlled reconcile logic around
  them.
- No unsupported `agent-orchestrator.yaml` schema (AO 0.9.x): a silently-ignored YAML
  block is not an acceptable enforcement surface; any config knob must demonstrably
  take effect.
- The covered-head predicate (#189), the start claim (#267/#308), the quiescence
  debounce (#261), and the delivery-confirm signal are **re-used, not forked** — no
  second definition of "covered", "claimed", "settled", or "consumed".
- Per-cycle arming/cooldown state persists in the existing orchestrator runtime state
  directory, **not** `.ao/**` and **not** committed; bounded; no secrets, prompt, or
  environment values.
- No new repo secrets.

## Verification

- A fixture drives the review-trigger plan step and the CI-green plan step with each
  cell of the scenario matrix above and asserts start-vs-defer (review) and
  nudge-vs-suppress (nudge) per cell. Worker activity, report state, CI level, and
  delivery-consumed signal are supplied from **captured / capture-derived** real
  `ao status` / `ao review list` / session shapes — the two `positive-outcome`
  assertions covered 1:1.
- A **head-burst** fixture: one worker advances `H1`→`H2`→`H3` mid-cycle; asserts ≤1
  review run and ≤1 nudge across the burst (the per-cycle, not per-head, invariant).
- A **prior-revision-open** fixture: review revision N's findings dispatched but not
  consumed; a newer uncovered green `ready_for_review` head yields **no** new review
  revision and a deferral record naming the open revision; after the findings are
  marked consumed + a settled re-handoff, exactly one next revision arms.
- A **busy-worker nudge** fixture: a streaming / actively-working head-owner on a
  green pre-handoff head receives **no** nudge; an idle-past-debounce pre-handoff
  head-owner receives exactly one.
- A **CI-flap** fixture, two variants: (a) D4=**working** while CI flips red→green →
  **no** nudge (working suppression overrides the flip, cell C6); (b) settled-idle
  pre-handoff while CI flips red→green→red→green → **one** nudge total across the
  flaps, not one per `greenEpoch` (cell C6b).
- A **no-co-fire** fixture (cell C8): a settled-idle pre-handoff worker on a green head
  gets the nudge **first**; the #261 fallback does **not** fire from the same
  evaluation; the fallback fires **only** as the sequential successor after the nudge's
  bounded expiry with no handoff; once the fallback is planned/started the nudge is
  suppressed and no second nudge arms. Asserts nudge and fallback never co-fire from one
  evaluation (a sequential nudge→fallback over the cycle is allowed; two nudges are not).
- A **stale-pending-delivery nudge** fixture: a worker that is genuinely idle but
  carries an unconsumed pending delivery past the bound is re-derived from live state
  and either gets its one nudge or is escalated — not suppressed indefinitely.
- A **drained-prior-revision** fixture (cell C10): an advanced head with a post-fix
  `ready_for_review`, green CI, quiescent, and the prior revision **drained** arms
  exactly one next review and suppresses the nudge — encoding the open→drained→
  next-review transition in the binding matrix.
- A **supervised-restart adoption** fixture/check: changed reconcile-child code that
  is merged but whose live child was **not** restarted still produces the old per-head
  behavior; the live confirmation step distinguishes "merged" from "adopted (child
  restarted)".
- A **settled-debounce** fixture: rapid commits then a clean handoff → the start waits
  while the head advances within the debounce and arms exactly one run on the final
  stable head.
- A **quiescent-fallback no-regression** fixture: a genuinely idle pre-handoff worker
  on a settled green head still gets its one #261 fallback review; the same worker
  advancing heads mid-cycle does not get one per head.
- A **liveness-without-commit** fixture: a review deferred for an open prior revision
  / unsettled head / pending debounce is serviced (exactly one run) on the first #163
  reconcile tick **after** the blocking condition clears — with **no** new head/commit
  to wake it — proving liveness is state-derived, not event-driven.
- A **consumed-vs-addressed** fixture: a prior revision whose findings are
  delivery-confirmed-consumed but with **no** post-fix settled re-handoff yet does
  **not** open the next revision; it opens only after the settled re-handoff. A
  separate **lost/delayed-consumed-marker** fixture: a missing or late consumed marker
  does not suppress review forever — the open-revision state is re-derived from live
  worker state and a stuck-open revision past the bound escalates rather than starves.
- A **crash/restart replay** fixture: a reconciler crash between "decide armed" and
  the `ao send` / `ao review run` does not leave the cycle marked armed for an action
  that never happened (the real action still arms on resume); a crash after the side
  effect but before recording does not duplicate on resume — exactly one armed action
  per cycle across the restart, via the existing fence + dispatch-journal replay.
- A **concurrent-children** fixture: the review-trigger child and the CI-green-wake
  child evaluate the same PR/head in the same window; the shared cycle state + fence
  yield **the single chosen action for that state class** — review-only when the head
  is handed-off review-ready, nudge-only for a lost-handoff cycle before expiry,
  fallback-only after the nudge expiry — and **never review+nudge co-firing from one
  settle**. (Asserting "one review and one nudge" together is wrong — it would bless
  the double-action class the precedence forbids.)
- A **one-nudge-total-per-cycle** fixture: an idle-but-not-handing-off worker whose
  nudge expires does **not** receive a second nudge in the same cycle (the next action
  is the #261 fallback per precedence); a second nudge appears only after the cycle
  closes and a genuine new settle occurs — proving the invariant is per-cycle-total,
  not per-outstanding.
- A **nudge-then-advance-no-handoff** fixture: after a nudge is sent, the worker
  advances the head and settles again **without** handing off; this does **not** close
  the cycle and does **not** re-nudge — proving head-advance+re-settle alone is not a
  terminal close event.
- A **matrix-consistency** check: every representative row's primary blocker / action
  is the output of the single decision table (not a hand-set value) and follows the
  multi-blocker precedence — so a C4-style cell cannot drift from the Binding contracts.
- A **multi-blocker precedence** fixture: a state satisfying several blockers at once
  (e.g. streaming + debounce-pending + prior-revision-open) records the most-durable
  blocker as the primary reason + next-wake condition (prior-revision-open, not
  debounce-pending) and lists all active blockers — so the audit/wake is deterministic.
- A **named-bound** fixture set: each timer (settled-head debounce, nudge expiry,
  open-revision stuck bound, stale-pending-delivery bound) resolves to a named
  constant/config default with below-bound suppression and after-bound
  escalation/fallback both tested; the nudge-expiry ≥ debounce relationship is asserted.
- A **cross-platform runtime-state** fixture: the restarted supervised children
  resolve and read/write the **same** runtime-state directory and the same
  cycle/claim/debounce keys across Ubuntu and Windows/WSL invocations for the same
  GitHub PR/head (no `C:\…` vs `/mnt/c/…` split into two stores, no `.ao/**` fallback)
  — so a path mismatch after restart cannot create duplicate arms or false suppression.
- A **worker-reassignment** fixture: the head-owner changes (kill+respawn / session-id
  rotation); the new owner is not suppressed by the prior owner's
  already-armed/already-nudged owner-scoped state, and does not duplicate it.
- A **reassignment-with-open-revision** fixture (the critical case): the owner changes
  while review revision N is **open** (findings not yet consumed + post-fix
  re-handed-off); the **PR-scoped review-revision lock is NOT released** — N is
  transferred/adopted/escalated, and **no** new review arms until N is drained
  (consumed + post-fix settled re-handoff) or terminal-failed. The owner-scoped
  cycle/nudge cooldown may reset, but the revision lock survives the reassignment.
- A **audit-log-growth** fixture: a single cycle with many intra-cycle head advances
  (H1→…→Hn) emits a **bounded** per-`(PR, cycle, branch)` coalesced suppress/defer
  record (first_head/last_head/count), not one record per head — proving the audit does
  not recreate the growth pattern.
- An **every-branch audit** fixture: each suppress/defer branch (unsettled-head
  debounce, busy-worker nudge suppression, prior-revision-open, already-nudged-cycle,
  already-reviewed-cycle, intra-cycle head advance, **CI-red defer**) emits its distinct
  operator-visible decision reason, coalesced/bounded per **`(PR, cycle, branch)`**
  (first_head/last_head/count) — not per head, not an unbounded stream, and not silent;
  per-head records appear only for action-producing or terminal decisions. The CI-red
  branch's deterministic primary/secondary blocker behavior when combined with others
  is asserted (it does not silently mask, or get masked by, a durable blocker).
- A **ready_for_review-then-advance** fixture: the worker reports `ready_for_review`
  for H2, then pushes H3 during the debounce with **no** new handoff; the post-debounce
  revalidation defers (no review on the stale-handoff head) until a fresh handoff for
  the current head — preserving #195's exact-current-head guarantee.
- A **nudge-expired-revalidation-fails** fixture: after the one nudge expires, fallback
  revalidation fails transiently (worker active again / CI red / source stale); the
  cycle holds nudge-expired-fallback-pending; a later healthy/quiescent tick produces
  the fallback/escalation — never a second nudge, never silent suppression.
- An **owner-resolution** fixture set: no-owner / multiple-plausible-owner /
  stale-session-rotation / conflicting-worktree-mapping each fail closed (no nudge bound
  to a guessed worker, no owner-scoped cooldown reset, distinct reason), while the
  PR-scoped review-revision lock is unaffected.
- A **nudge-clear** fixture: an outstanding nudge's bounded expiry clears the
  outstanding record **only** to allow the #261 fallback/escalation **in the same
  cycle** — it does **not** authorize a second nudge. A new commit or CI flap alone
  does not clear it. A second nudge arms only after one of the enumerated terminal
  close events **and** a new cycle has opened — never from expiry+re-settle within the
  same cycle.
- A **review-armed-before-findings** fixture: a review is planned/started but findings
  are not yet dispatched; a head advance / re-handoff in that window arms **no** second
  review — the review-revision lock holds from planned/started, not only from
  findings-dispatched.
- A **prior-open-quiescent-nudge** fixture: a worker is idle/quiescent on a green head
  while a prior review revision is **open**; CI flips green → **no** nudge (prior-open
  suppresses the nudge even when the worker looks idle), distinct from the lost-handoff
  cycle with no open revision (which does get its one nudge).
- A **debounce-key-collision** fixture: records for the three uses (#261 fallback,
  ready_for_review debounce, CI-green nudge) for the same PR/head do not collide — a
  fallback debounce record does not suppress a clean-handoff review start, and a nudge
  record is not read as review-settled state.
- A **live-state upgrade/migration** fixture: pre-upgrade undiscriminated #261/#267-
  style runtime records already present at adoption are migrated or safely ignored —
  no duplicate fallback/review arm, no lost outstanding debounce, no false
  clear/suppression — proving a clean new-key implementation cannot silently strand
  in-flight old state on restart. **The migration also bootstraps already-nudged-cycle
  state from the existing CI-green dispatch/pending journal** (not only #261/#267
  records), or explicitly fences adoption mid-cycle with an audited "unknown
  pre-upgrade nudge state" decision — so a worker already nudged per-head by the old
  system does not get a one-time duplicate nudge right after rollout (the exact storm
  window this draft targets).
- A **delivery-confirm revision-identity precondition** check: the current
  delivery-confirm record is shown to carry the exact review-revision/delivery identity
  (or the minimal read/key change that adds it is included), so the consumed match is
  revision-exact — not a coarse PR/head/session signal.
- A **source-freshness** fixture per required source: an old-but-readable snapshot
  (e.g. a head SHA that no longer matches the PR's current head, or an inconsistent
  record version) is treated as stale and fails closed, not armed on; the named
  escalation bound fires when freshness cannot be proven.
- A **shared-key-helper usage** check: both reconcilers resolve cycle/debounce/nudge
  record identity through the **same** canonical helper (not duplicated per-child path
  normalization) — asserted so Windows/WSL path forms cannot diverge the two consumers.
- A **runtime-record redaction** check: the new cycle/arming records and any new log
  lines contain no raw prompt/context, environment values, tokens, or session payloads
  — only bounded non-secret identifiers and reasons.
- A **fallback-revalidation** fixture: during an outstanding nudge the head advances /
  owner changes / CI goes red; after the nudge expiry the #261 fallback does **not**
  launch on the stale settled head — it revalidates the fresh snapshot and re-defers.
- A **revision-identity consumed** fixture: a stale consumed marker for revision N-1
  does **not** drain revision N — the next review does not arm until N's own
  delivery/consumed identity is satisfied.
- A **clean-review lock-release** fixture: a review revision that completes
  **clean / no-findings** releases the review-revision lock **immediately** (no consumed
  marker or re-handoff exists to wait for); a later legitimate review cycle for the PR
  is not deferred forever by a stuck-open lock.
- A **terminal-failed/cancelled lock** fixture: a planned/started review revision that
  ends `failed`/`cancelled`, with a newer head / re-handoff present, releases the
  review-revision lock to a **bounded retry/escalation** per the existing #60/#98 bound
  — exactly one diagnosed retry then escalate, **no** duplicate review arm during the
  head churn, and **no** permanent starvation of the PR after the terminal failure.
- A **denied-path precondition** check: if making the delivery-confirm signal
  revision-exact would require a producer change under `packages/core/**` / `vendor/**`,
  the gate is **not** shipped against the coarse signal and the PR is recorded as
  dependent on a prior upstream/core identity issue (fail-closed, denylist intact).
- A **fail-closed-source** fixture: for each required live source (`ao status`,
  `ao review list`, the consumed signal, PR head state) being missing / stale /
  partially-unreadable / inconsistent, the reconciler arms **no** review or nudge,
  clears **no** open-revision / stale-delivery / cycle record, records a distinct
  read-error=unknown defer/escalate reason, and resumes correctly once the snapshot is
  healthy (no wrong-arm, no permanent suppression).
- Closed-sibling regression suites (#189/#195/#261/#267/#308) run green.
- **Mandatory live adoption (no skip).** Because this gate runs in long-running
  supervised children, the PR MUST list the supervised-child restart adoption steps and
  a **live** confirmation — from the running reconcilers after restart — that a
  mid-cycle head advance produces no second nudge/review. This step is **required for
  this change regardless of whether any operator-facing config surface changed** (a
  code-only change still needs the restart); it cannot be waived as "no operator
  adoption required".
- The synced GitHub Issue number is bound by the implementing PR (the draft's
  `GitHub Issue:` line is set at sync, not left `TBD` once published).

## Decisions

**Prior art (recon verdict: extends / references existing).** A coworker survey of
the drafts corpus + the closed-issue queue confirmed the existing settle-gate is
**handoff-state-based**: #195 (wait for `ready_for_review` on the exact head) is the
primary gate, #189 dedups the same head, #261 adds the quiescent fallback + 15-min
debounce for a lost handoff, #267/#308 add the per-`(PR,head)` start claim, #103/#318
made the gate mechanical for the LLM turn. **No existing draft** rate-limits across
successive *legitimate* re-handoffs within one fix cycle, and **nothing** gates the
CI-green nudge by worker-busy/streaming. This draft fills exactly that gap; it
re-uses every listed mechanism and adds the per-cycle layer above them. RCA this
session (PR #327): live state + supervisor logs show ci-green-wake nudged opk-1 ~10×
over ~1.6h, one per new head (`ci-green-wake-reconcile.log` 09:35→11:13), and
review-trigger started ~8 runs on PR #327 over ~3.5h, one per advanced head
(`review-trigger-reconcile.log`) — both because `(PR, headSha)` resets idempotency on
every commit. Full RCA matrix:
`/tmp/orchestrator-pack-review-storm-scenario-matrix.md`.

**Recurrence (recurrence-diagnostic).** This is a recurrence of #195's intent ("stop
premature runs on intermediate commits"). #195's acceptance still passes — a
non-handed-off intermediate commit is correctly skipped — yet the storm reproduces,
because the storm comes from legitimate repeated handoffs + the #261 quiescent
fallback + the ungated nudge, not from the one cell #195 closed. `pass + reproduce` ⇒
the spec closed one equivalence cell; the durable fix names the whole class (the
matrix), per [[fix-the-class-not-the-case]].

**Chosen option (cheapest sufficient with acceptable risk).** Options judged on
cost/risk/sufficiency:
- (A) **Reference / extend the shipped handoff-state machinery** with a per-PR
  "one open review revision at a time" gate + extend the existing #261 quiescence
  signal to the nudge and to the ready_for_review path — **chosen.** Re-uses the
  delivery-consumed signal, the debounce store, and the activity signal already in
  the reconcilers; state-derived (no new wall-clock subsystem); lowest new surface,
  lowest regression risk against the closed siblings.
- (B) A blunt **per-PR wall-clock cooldown** ("no review/nudge for PR X within T of
  the last") — rejected as the primary mechanism: cheap but coarse; it throttles
  legitimate fast handoffs and still fires on flaps; it does not encode "prior
  revision still open," so it under-fits symptom 2. Retained only as a secondary
  ceiling if (A) proves insufficient under load.
- (C) Move the decision into the LLM orchestrator turn (prose) — rejected: same class
  as the failures #103/#318 already fixed (a model cannot be bound by prose); the gate
  must be mechanical in the reconcilers.

**Decomposition note (one spec, sequenced implementation).** The two surfaces (nudge
suppression, review per-cycle gate) are kept in **one draft** because they share the
same root contract — arming on worker-iteration state, not per head — and the same
re-used signals; the matrix treats them as one class with shared sibling cells. The
GPT loop repeatedly recommended **splitting the implementation, not the spec**: land
the shared cycle/key/owner resolver + read-only decision table first (no behavior
change, migration/bootstrap observable), then enable the review-trigger gate, then the
CI-green nudge/fallback precedence. That internal PR sequence is the recommended build
order; it does not require splitting this issue.

**GPT adversarial loop (discuss-with-gpt) + Codex sync gate.** GPT loop run per the
user's «с gpt» instruction; the standard Codex architect draft-review then ran as the
sync gate and returned **NO_FINDINGS** after 4 iterations (P1 nudge/fallback
action-count wording made consistent; P2 `D5=any` matrix rows qualified to
none/drained; clean-review lock-release path added; shared-resolver bound to outcome
not a function). The GPT browser bridge dropped between passes twice (operator
relaunched the automation Chrome); see [[discuss-with-gpt-chrome-launch]].

GPT loop: 10 passes; stopped because cap-10; last-pass accepted=5; final
STATE=completed_valid VALIDATION=ok pass=b940c3cc-b336-4fa6-b9e4-2f1dbf65ecb8
sha=d33513d6976749bc56b2b98228a8c8bc050a09569a1ec85020994044f728b316.
**Post-GPT change not re-reviewed:** the pass-10 sha covers the draft *input* to pass
10; the 5 pass-10 findings were **applied** after the cap (not left open), so the final
draft is one revision past the bound sha — those 5 edits (ready_for_review-debounce
current-head revalidation; nudge-expired durable fallback-pending state; migration
bootstrap from the CI-green dispatch journal; CI-red audit branch; fail-closed
owner-resolution) were not themselves re-challenged by GPT. Re-run GPT or rely on the
pending Codex draft review to cover them.

Accepted across passes 1–10 (rejected: split-the-issue, TBD-blocks-sync,
full-Cartesian-matrix): shared per-cycle state machine defined first
(start/advance/close/ownership/crash); consumed≠addressed (post-fix settled re-handoff,
not a consumed marker); state-derived liveness via #163 (no new wake); atomic phased
crash-recoverable arming on the existing fence + dispatch journal; audit every
defer/suppress branch with deterministic multi-blocker precedence; in-body
representative matrix derived from one decision table; explicit nudge-clear event;
one-nudge-**total**-per-cycle; busy/streaming + prior-revision-open nudge suppression;
single-action-per-settle nudge↔#261 precedence with fresh-snapshot fallback
revalidation; named/tested timer bounds; surface-discriminated + cross-platform-
canonical state keys; review-revision lock spanning planned→terminal-drained;
PR-scoped lock survives owner change (the critical fix) vs owner-scoped cooldown;
revision-identity-exact consumed matching with denied-path (core/vendor) blocking
outcome; terminal-failed/cancelled lock release; fail-closed required-source freshness;
ready_for_review current-head revalidation; owner-resolution fail-closed.
