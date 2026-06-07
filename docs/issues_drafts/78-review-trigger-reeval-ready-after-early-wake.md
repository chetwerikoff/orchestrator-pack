# Review must start seconds-scale when readiness lands after an early completion wake, not fall to the 10-min backstop

GitHub Issue: #235

## Prerequisite

- `docs/issues_drafts/70-orchestrator-event-driven-review-trigger.md` (GitHub #207) —
  the event-driven fast trigger this draft extends. #207 evaluates readiness **once,
  on receipt of the completion wake** (wake-edge). It **logged a deliberate scope
  decision** to leave the "no usable wake at readiness" case to the periodic backstop.
  This draft narrows that scope-out for one concrete, observed sub-case (below); it
  does **not** reopen #207's "just shorten the interval" rejection. **Context, not a gate.**
- `docs/issues_drafts/67-orchestrator-review-gate-on-handoff.md` (GitHub #195) — the
  canonical "head ready for review" predicate; consumed **verbatim** (CI red-defers-only;
  failed/cancelled first; degraded-CI escalates). **Context, not a gate.**
- `docs/issues_drafts/72-reconcile-ready-head-defer-subreason.md` (GitHub #212) — the
  enumerable defer subreason (`uncovered_not_ready` / `no_ready_for_review`) this path
  keys off to know a head was deferred for "report not yet accepted." **Context, not a gate.**
- `docs/issues_drafts/76-golden-sample-fixtures-field-shape-guard.md` (GitHub #223) —
  the capture-backed field-shape guard; the readiness/wake fixtures here must be
  production-representative under it. **Context, not a gate.**
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205) —
  **merged / on `main`** (the supervisor and its side-process registry exist). This
  prerequisite is **satisfied, not pending**: the re-evaluation surface plugs into the
  **live** registry — it is not blocked on unlanded supervisor work. Because this path
  issues `ao review run` (a side effect), that surface must live under draft 71's
  supervised, drain/fenced, restart/stall-idempotent side-effecting-child machinery —
  never the LLM orchestrator turn.

## Goal

When a worker's review-ready head becomes ready **after** the only completion-time
wake already fired (and was correctly deferred as not-yet-ready), the **first**
`ao review run` for that head must still converge **seconds-scale**, not wait for the
periodic review-trigger reconcile (default 10 min) or the heartbeat. #207 fires the
fast trigger only on the wake edge; in the observed incident the completion wake
arrived **before** the worker recorded `ready_for_review`, so the wake-edge evaluation
deferred and nothing re-evaluated the head until the backstop. Close that residual
ordering race while preserving every #195/#189/#207 invariant and keeping the
periodic reconcile as the backstop.

```behavior-kind
action-producing
```

**Root cause (5 Whys, condensed).** Review did not start seconds-scale → the fast
path (#207) deferred the head as `uncovered_not_ready` → at wake-receipt no accepted
`ready_for_review` existed for the head SHA → the completion wake arrived **before**
the `ready_for_review` report (incident PR #234/opk-27: wake ~14:16:41Z, report
~14:17:58Z, ~77 s later) → #207 evaluates readiness only on the wake edge and AO 0.9.x
emits no `ready_for_review` wake to re-trigger it → so the head waited for the ~10-min
reconcile backstop (ran ~14:24:38Z, ~6.5 min after readiness).

## Binding surface

- **The trigger decision is a pure, idempotent function of observed state — events are
  hints, not the source of truth.** Whether to start a review for a head MUST be derivable
  from observed AO/GitHub state (latest accepted report + SHA, CI state, existing run
  state) such that **any** observer — the completion wake, a readiness-state-change hint,
  the recovery/startup re-seed, the periodic reconcile — computes the **same** verdict.
  **Idempotency is about the verdict, not global exactly-once execution:** re-applying the
  decision when a covered-terminal or in-flight run already exists for the head is a
  **no-op** (no new run). The **only** tolerated duplicate side effect is the inherited
  #189 concurrent-observe TOCTOU — at most one **benign `outdated`** run for the **correct**
  head, never a wrong-head run and never any spawn/claim/kill/merge/send — and it must be
  **distinguishable in logs**. (A durable per-PR/head claim via the existing #205
  side-effect fence to collapse concurrent observers to a single run is **preferred** where
  cheap, but the planner chooses; the hard floor is the benign-bound above.) Wakes and
  report-state changes only **expedite** re-evaluation; correctness comes from re-applying
  the decision to current state ("edge-triggered hint, level-triggered truth"). This is the
  invariant that makes event ordering, restarts, and concurrent observers stop producing
  new defects — not a per-ordering patch.
- **Re-evaluate deferred heads on readiness change, not only on the wake edge —
  causally, not by a generic poll.** When a completion wake deferred a head specifically
  because it was not-yet-ready (the #212 `no_ready_for_review` / `uncovered_not_ready`
  subreason — *not* red-CI, *not* covered, *not* failed/cancelled), and that head
  subsequently becomes #195-ready, a **draft-71-supervised surface** must drive the first
  `ao review run` for it seconds-scale. The re-evaluation MUST be **causally driven by the
  readiness-state transition** (the acceptance of the `ready_for_review` report for the
  head), **not** by a fixed-interval always-on poll over a deferred-head cache: a periodic
  poller is the "just shorten the reconcile interval" alternative #207 **already rejected
  by logged decision**, and reintroduces the timer/backlog failure class draft 71 isolates
  (it would also violate this draft's own upgrade-safety "no shared failure path with the
  backstop"). The **mechanism** stays the **planner's choice** within that boundary —
  drive off a captured usable readiness notification where AO emits one, or off an observed
  worker-report/state transition where it does not. Where AO emits **no** usable readiness
  signal at all (per the capture below), a re-check is permitted **only** when it is (a)
  **scoped** to the small set of recently-deferred-not-ready heads (never a second
  full-open-PR periodic sweep), (b) **bounded** to a short convergence window per head,
  then hands the head back to the backstop, and (c) **explicitly classified** as such in
  the design — it must **not** masquerade as event-driven nor duplicate the reconcile. It
  must **not** depend on AO emitting a dedicated `ready_for_review` / `review.pending` wake
  (see next bullet) and is **not** the LLM orchestrator turn.
- **Do not assume a `ready_for_review` wake exists — determine AO's real behavior,
  capture-backed.** #207 asserts AO 0.9.x emits no `ready_for_review` wake; the
  incident listener log shows no accepted `ready_for_review` wake for the head, only
  the early `merge.ready` and `info_priority` / `not_wake_relevant` drops. The planner
  MUST establish, from a **captured** AO notification payload (per #223), whether the
  `ready_for_review` transition produces any webhook notification and at what priority
  — and design the re-evaluation so it is correct **whichever** holds (no wake at all,
  or a wake dropped by the existing priority/relevance filter). A fix that silently
  assumes one of these without capture-backed evidence is out of contract.
- **Readiness predicate = #195 verbatim.** A head re-evaluates as eligible exactly when
  the #195 predicate holds for the **exact** head SHA (latest accepted `ready_for_review`,
  required CI green-or-genuinely-pending, not red, not missing; failed/cancelled first).
  No weaker local notion of "ready."
- **Re-evaluation targets only the current PR head (SHA-bound).** The `ao review run` is
  bound to the exact PR + normalized head SHA that satisfies a **fresh** #195 snapshot
  **and is the current PR head** at run time. A deferred SHA that is **no longer the PR
  head is discarded** — it is **never** reviewed as a stale-but-ready commit. If the head
  advanced past the deferred SHA, the new head is reviewed **only after its own** #195
  readiness (its own accepted `ready_for_review` for that exact SHA); if the new head is
  not yet ready, the path defers again and re-evaluates when **it** becomes ready. The
  path **never** issues two concurrent runs (old + new head). This preserves #195's bar
  against reviewing an intermediate/unhanded-off commit.
- **Covered-head + in-flight dedupe (reuse #189), bounded not race-free.** No new run
  when a covered-terminal (`clean` / `needs_triage` / `waiting_update`) or in-flight run
  exists for the head, re-checked on a fresh snapshot immediately before the run. The
  fast path, this re-evaluation, the periodic reconcile, and any LLM turn remain
  independent observers: the residual TOCTOU is **identical to #189/#207** and must stay
  **benign** — at worst a redundant/`outdated` run for the **correct** head, never a
  wrong-head run and never any spawn/claim/kill/merge/send.
- **Review-run only.** This path issues **only** `ao review run` — no spawn,
  `--claim-pr`, kill, merge, or `ao send`. Identical envelope to #163/#207/#202.
- **Deferred-head tracking survives restart/drain/stall — including readiness that lands
  while the surface is down.** The set of recently-deferred-not-ready heads MUST NOT live
  only in process memory: a supervised drain/restart/stall occurring **between** the early
  wake's deferral and the later readiness MUST NOT drop the fast-path trigger. Either
  persist the deferred-head set under the supervisor state dir (surviving restart) **or**
  deterministically reconstruct it from observed AO state on start. Crucially, this MUST
  cover the case where the `ready_for_review` transition is **accepted while the surface is
  offline/fenced** (the readiness *event* is missed): on **startup/recovery** the surface
  MUST **re-read current AO/GitHub state** for its persisted/reconstructed deferred heads
  and fire seconds-scale from recovery when #195 now holds — it MUST NOT depend on having
  observed the live transition. This is the recovery face of the state-derived decision
  above: a missed event never strands a head. If the bounded window elapsed in wall-clock
  during downtime, recovery treats the persisted head as a **fresh state observation** (re-
  evaluate now); the periodic reconcile remains the final backstop. (Mechanism is the
  planner's choice; durability + recovery-re-read is the requirement.)
- **Bounded re-evaluation window must cover real readiness delay.** The per-head
  re-evaluation window must be **bounded** (no forever-retry: it converges on readiness or
  hands the head back to the backstop), but the bound MUST be large enough to cover the
  **captured** wake→readiness delay (the incident observed ~77 s) **with margin**, and the
  chosen value MUST be documented. A window that can expire before a realistic post-wake
  readiness lands (e.g. 30 s) is non-conformant — it would miss the exact failure mode
  while satisfying the never-ready boundedness check. A head that never becomes ready, or
  whose worker disappears, hands back to the backstop without an unbounded loop or a
  duplicate side effect.
- **Transient AO/GitHub failure preserves the watch entry — never strands a ready head.**
  A read error or timeout on the #195 snapshot, the run-state lookup, or the CI query is
  treated as **unknown** — never as not-ready, covered, or handled: the head **stays** in
  the deferred/watch set and is retried within the bounded window. An `ao review run` that
  **definitively** failed before the run was created keeps the head in the **durable**
  watch set (surviving restart) and retries under the supervised bounded window. An
  **ambiguous** outcome (timeout or unknown exit, where AO may have **created the run
  after** the caller stopped observing) MUST NOT be assumed "no run created": the path
  **re-reads run-state until AO visibility is established** and retries **only** if that
  fresh snapshot proves **no** in-flight or covered run exists for the head (the #189
  dedupe), so an ambiguous timeout never produces a duplicate same-head run. The
  side-effect fence/lock MUST be **released on any failure** so a crashed/aborted attempt
  leaves **no stale lock** stranding future ticks. Only after **documented**
  retry/window exhaustion does the head hand to the periodic backstop, with an observable
  log/metric. This is distinct from a `failed`/`cancelled` **review outcome** (crit 6 /
  empty-review trap), which is a run that *executed*; here the run could not be created at
  all.
- **Periodic reconcile stays the backstop.** Additive fast path only; the #163
  review-trigger reconcile and heartbeat remain in place and are not removed or
  shortened as the design.
- **Operator adoption.** If this introduces a new managed process, env var, or a wake/
  notification-mapping change requiring `ao stop` / `ao start` or a wake-process restart,
  list the post-PR operator steps (any yaml-example merge, the process/launch change,
  new env with a safe default, the restart, and a verification command). If it only
  changes already-supervised behaviour, state that explicitly. Coordinate supervised
  liveness with draft 71 — ship no new unsupervised long-running process.

## Files in scope

- `scripts/**` — the re-evaluation path and its tests (new files as the planner
  declares them), consistent with the existing wake / reconcile / supervisor scripts.
- `docs/**` — the wake-decision / event-filter surface and the go-live + recovery
  runbooks; `prompts/agent_rules.md` / canonical `orchestratorRules` reference if the
  contract is stated there; a captured AO `ready_for_review` notification sample under
  the #223 golden-sample location.
- `agent-orchestrator.yaml.example` — only if the canonical `orchestratorRules` /
  notification-routing contract must change.
- Test fixtures for the wake-before-readiness, dedupe, SHA-bound, and bounded-retry
  scenarios.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**`.
- The local (gitignored) `agent-orchestrator.yaml`.
- Removing/rewriting the periodic review-trigger reconcile (#163) or the heartbeat —
  they stay as backstops.
- The wake-edge fast trigger contract of #207 itself (this draft adds re-evaluation
  around it; it does not rewrite #207's wake-edge behavior).
- Delivery of findings after review (`ao review send`) — owned by #202/#171.
- The **genuinely zero-signal** head (no completion wake **and** no in-progress AO report —
  nothing to react to): explicitly backstop-only (the periodic reconcile converges it). A
  seconds-scale guarantee there would require the full-PR poll #207 rejected; see crit 14.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. **Re-evaluation closes the ordering race.** In a fixture replaying the incident
   ordering — completion wake delivered for a head whose `ready_for_review` is **not
   yet** accepted (fast path defers `no_ready_for_review`), then the `ready_for_review`
   report for the **same** head SHA is accepted — a review run for that SHA is created
   **without** any periodic reconcile or heartbeat tick firing (both disabled/not-yet-due
   in the fixture), with no manual command. The same fixture proves the trigger is
   **causal, not a disguised poll**: the run is produced by the readiness-state transition
   while the periodic reconcile and heartbeat timer machinery are disabled, and the path
   runs **no** always-on fixed-interval sweep over all open PRs (any permitted re-check is
   scoped to recently-deferred heads and converges within its bounded window).

   ```positive-outcome
   asserts: first `ao review run` for the head is created after readiness lands, with the periodic reconcile and heartbeat disabled/not-yet-due
   input: external-tool-output
   provenance: capture-backed
   ```

2. **Seconds-scale, falsifiable.** The path's **own** processing from observed
   readiness to the `ao review run` decision is asserted under a concrete seconds-scale
   upper bound in fixture/logical time (planner picks and documents the number),
   **excluding** explicitly modeled external AO/GitHub command latency. A handler that
   defers re-evaluation for minutes **fails** the fixture even when no periodic tick fired.
3. **Capture-backed AO behavior.** A committed, production-representative capture (per
   #223) records whether AO 0.9.x emits any notification on the `ready_for_review`
   transition and its priority/kind; the re-evaluation design is shown correct against
   that captured reality (whether the wake is absent or filtered), not a plausible-but-
   unverified assumption.
4. **#195 verbatim, current-head-only.** Re-evaluation triggers only when the #195
   predicate holds for the **exact current PR head** SHA. Fixtures cover three churn
   cases: (a) the deferred SHA is **still the head and now ready** → run for it;
   (b) the head **advanced past** the deferred SHA → the stale SHA is **discarded, no
   run**, and the new head triggers **only** after its **own** #195 readiness; (c) the new
   head is **not yet ready** → defer again, **no run**, re-evaluate on its readiness. **No**
   fixture path produces two runs for old + new head. A red-CI head defers; a
   missing/unknown-required-CI head routes to degraded-CI escalation, not a run.
5. **Dedupe + benign residual race.** No run when a covered-terminal or in-flight run
   exists for the head (reuse #189). A fixture with the re-evaluation and the reconcile
   both observing the same now-ready head produces at most a redundant/`outdated` run for
   the **correct** head — never a wrong-head run, never any spawn/claim/kill/merge/send.
6. **Failed/cancelled precedence.** `failed` / `cancelled` on the current head is
   evaluated before the head-ready predicate and routed to the EMPTY REVIEW TRAP
   (`terminationReason` + retry-once), never treated as covered.
7. **Bounded, no runaway.** A head that never becomes ready (or whose worker
   disappears) is re-evaluated only within a bounded window, then handed to the backstop
   — a fixture shows no unbounded retry loop and no duplicate `ao review run`.
8. **Review-run-only scope.** A scope/test assertion shows the path never spawns,
   `--claim-pr`s, kills, merges, or `ao send`s.
9. **Supervised + fenced (same PR).** The re-evaluation surface lands under draft 71's
   side-effecting-child machinery in the **same PR** (registry entry or reclassification
   of an existing registered child, plus drain/fence/restart/stall/idempotency coverage);
   a test shows no duplicate `ao review run` on restart/stall and no unsupervised
   side-effecting surface.
10. **Backstop survives.** The periodic reconcile and heartbeat remain functional
    backstops (not removed); a fixture shows the run firing from the re-evaluation path
    rather than the backstop for the incident ordering.
11. **Restart-durable deferred state, including readiness-during-downtime.** Two fixtures:
    (a) the supervised surface drains/restarts (or stalls and is recovered) **after** the
    early wake defers the head and **before** readiness lands; (b) the `ready_for_review`
    transition is accepted **while the surface is offline/fenced** (the live event is
    missed), then the surface restarts. **Both** must produce a seconds-scale `ao review
    run` when #195 holds — case (b) by **recovery re-reading current AO/GitHub state** for
    persisted/reconstructed deferred heads, not by having observed the transition. No
    duplicate run results from the restart; if the window elapsed during downtime, recovery
    re-evaluates from current state (and the backstop remains).
12. **Delayed-readiness within window.** A fixture where readiness lands after a realistic
    post-wake delay at least as long as the captured incident delay (≥ ~77 s) but before
    the documented window expiry still triggers seconds-scale from the readiness transition.
    A second fixture with a too-short window (expiring before that delay) is shown to be
    **non-conformant** (it must hand to the backstop, and the documented window must exceed
    the captured delay with margin).
13. **Idempotent state-derived decision (verdict, not exactly-once).** A test feeds the
    same observed state to the trigger via different entry paths (wake/readiness hint,
    recovery re-seed, periodic reconcile) and shows an identical run/no-run verdict.
    Re-applying the decision when a covered-terminal or in-flight run already exists for the
    head is a **no-op** (no new run). The **only** tolerated duplicate is the named #189
    concurrent-observe TOCTOU — at most one benign `outdated` run for the correct head,
    **distinguished in logs** — and a test asserts no other duplicate side effect arises
    from re-application on unchanged state.

14. **Dropped/absent completion wake vs genuinely-zero-signal — explicit split.** The
    deferred/watch set is seeded not only by the completion wake but from **any observed
    in-progress signal** (an accepted in-progress report, or a recovery re-seed of open PRs
    whose worker is progressing toward review without a covering run), bounded/scoped — not
    a full periodic sweep. A fixture where the completion wake is **dropped/never fired**
    but the worker's in-progress state is observable shows the head still converges
    **seconds-scale** from the seeded/re-read state (the periodic reconcile being
    disabled) — `reconcile catches it` is **not** an acceptable outcome here. Only the
    **genuinely zero-signal** head (no wake **and** no in-progress report — nothing to react
    to) is **explicitly backstop-only**, documented as out of scope with rationale (a
    seconds-scale guarantee there would require the full-PR poll #207 rejected); a test
    asserts that carve-out is the *only* case that falls to the backstop.

15. **Transient failure semantics.** Fixtures: (a) the #195 snapshot / run-state / CI read
    **errors or times out** mid-evaluation → the head is treated as **unknown**, retained
    in the watch set and retried within the window — **not** treated as not-ready or
    handled; (b1) `ao review run` **definitively** fails before creating the run → the head
    stays in the **durable** watch set, retries within the window, and the fence/lock is
    **released** (a fixture asserts **no stale lock** after an aborted attempt), converging
    on a later retry; (b2) `ao review run` **times out / unknown exit after AO created the
    run** → a fixture asserts the path **re-reads run-state**, sees the in-flight run, and
    issues **no** duplicate retry; (c) retry/window **exhausted** → handed to the
    backstop with an observable log/metric. Durable watch state survives a restart during
    any of these.

### Scenario matrix (exhaustive — each cell is a fixture)

The re-evaluation must produce the stated outcome for **every** cell below; fixtures cover
each. Cells already owned by a merged issue are cross-checked for **no regression**, not
re-implemented.

| Condition | Expected outcome |
|---|---|
| wake **after** ready, head ready, uncovered | run once (already #207) — no-regression check |
| wake **before** ready, then ready on same head | run once seconds-scale from readiness (**this draft**, crit 1–2) |
| completion wake **dropped/absent** but worker progressing (report/state observable) | recovery/seed from observed AO state still fires seconds-scale (**crit 14**) — *not* "reconcile catches it" |
| **genuinely zero AO signal** for the head (no wake **and** no in-progress report) | explicitly **backstop-only, out of scope** — no event/state to react to; reconcile is the convergence guarantee (rationale documented, crit 14) |
| restart/drain/stall between defer and ready | still runs seconds-scale on readiness (**crit 11a**) |
| readiness accepted **while surface offline/fenced**, then recovers | recovery re-reads state, fires seconds-scale from recovery (**crit 11b**) |
| readiness delayed ~≥77 s but within window | runs from readiness (**crit 12**) |
| head advanced past deferred SHA | discard stale SHA; new head only after its own #195 (**crit 4b**) |
| head advances after run started | run is `outdated`; no wrong-head review (crit 4) |
| covered-terminal / in-flight run exists | no new run (#189, crit 5) |
| concurrent observers (fast+reconcile+ci-green) | at most benign `outdated`; never wrong-head/duplicate side effect (crit 5, 13) |
| `failed`/`cancelled` on head | empty-review trap, retry-once; not covered (crit 6) |
| red CI | defer, no run (crit 4) |
| missing/unknown required CI | degraded-CI escalation, not a fast run (crit 4) |
| CI flips green→red after defer | re-evaluation re-reads state and defers (level-truth, crit 13) |
| never-ready / worker vanished | bounded re-check then backstop; no runaway, no dup (crit 7) |
| transient read error/timeout during evaluation | unknown → retain + retry, not not-ready (**crit 15a**) |
| `ao review run` **definitively** fails pre-create | retain in durable watch, retry, **release fence** (no stale lock) (**crit 15b1**) |
| `ao review run` **times out after creating** the run (ambiguous) | re-read run-state, see in-flight, **no duplicate retry** (**crit 15b2**) |

## Upgrade-safety check

- No edits under `packages/core/**` or `vendor/**`; AO is consumed, not patched.
- No unsupported YAML fields — drive review through the CLI; no `reviewer:` block.
- No new repository secrets.
- The re-evaluation surface shares no failure path with the periodic reconcile or
  heartbeat (independent supervised child / drained-fenced behavior per draft 71).

## Verification

- pwsh 7+ tests / fixtures for criteria 1–15 and every **Scenario matrix** cell
  (ordering-race closure, seconds-scale
  bound, capture-backed AO behavior, #195+SHA-bound, dedupe/benign-residual,
  failed/cancelled precedence, bounded re-eval, review-run-only scope, supervision,
  backstop survival), runnable in CI without a live AO.
- A dry-run / fixture demonstrates: deferred-then-ready → run created seconds-scale with
  backstops off; covered / red-CI / intermediate-commit head → no run; never-ready head →
  bounded re-eval then backstop, no duplicate run.
- The committed AO `ready_for_review` notification capture (criterion 3) is present and
  referenced by the fixture.
- Where the contract lives in `orchestratorRules` / `agent_rules.md`, the strict
  diagnose path (`scripts/orchestrator-diagnose.ps1 -Strict` live, or the CI fixture
  gate) still passes.
