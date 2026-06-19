# Auto-submit arbiter must dispatch Enter regardless of worker-busy state and retry until consumed

GitHub Issue: #293

## Prerequisite

- `docs/issues_drafts/89-worker-message-delivery-confirmed-consumption.md`
  (GitHub #281, merged) — the journaled-delivery arbiter with three-phase
  crash-safe accounting and bounded escalation this issue **extends**. The
  consumption predicate, the single-flight claim, the no-payload-replay
  invariant, and the bounded-escalation guarantee defined there are the surface
  this changes. It does not replace it.
- `docs/issues_drafts/77-worker-message-submit-source-agnostic.md` (GitHub #232,
  merged) — the source-agnostic submit arbiter. Its `isSessionStreaming` /
  busy gate is the specific contract this issue **rewrites**, and its
  `stale_input` / `draft_present` authority is the gate this issue keeps.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205,
  merged) — the arbiter runs under the existing supervised side-process host; no
  new unsupervised process, and the operator-visible escalation reuses that
  host's escalation channel.

## Goal

A delivered-but-unconsumed worker draft must be **submitted (Enter) promptly and
retried until it is consumed or bounded-escalated** — without waiting for the
worker to be idle. The arbiter today refuses to press Enter while the worker is
streaming/busy (`isSessionStreaming` → `noop reason=streaming`, from #232) on the
assumption that Enter would interrupt or be unsafe mid-turn. **That assumption is
false** (see Background): pressing Enter on a busy Codex worker safely *enqueues*
the submit for after the current tool call — it does not interrupt (Esc
interrupts). The busy-refusal therefore both delays the submit and lets the
per-delivery wall-clock budget expire with **zero submit attempts**, abandoning
the draft (`ambiguous_budget_exhausted`). The fix: dispatch Enter regardless of
worker-busy state, drive retry from **consumption verification** (not from a
clock the worker can run out by being busy), gate re-dispatch on **content
freshness** (not on worker-idleness), and keep escalation bounded and
operator-visible — preserving every #281/#232/#216 crash-safety, single-flight,
fail-closed-ambiguity and no-payload-replay invariant.

```behavior-kind
action-producing
```

## Background (why this is open, and why the premise changed)

The original draft for this issue (and #281's budget) rested on the premise that
the arbiter may only safely press Enter during a narrow **idle** window, so a
per-delivery budget "racing" that window was the defect. **Live evidence on
2026-06-13 overturns that premise.**

- **opk-61 (Codex/gpt-5.5, PR #289), proven live.** A multi-line message was
  Enter-pressed while the worker was mid-turn (busy). The Codex TUI showed
  *"Messages to be submitted after next tool call"* — i.e. Enter **enqueued** the
  submit, it did not interrupt. After the tool call the queue flushed, the
  message was **fully consumed**: the worker ran a 10m01s turn, pushed head
  `9c90f3c2`, and reported `ready_for_review`. So Enter-on-busy is a safe enqueue;
  **Esc**, not Enter, is the interrupt.
- **opk-57 / opk-58 (same PR), the stuck findings.** Each had its review-send
  finding sitting as an unsubmitted `[Pasted text]` draft. opk-58 had **exactly
  one** delivery yet escalated `ambiguous_budget_exhausted` — delivered 08:15:45,
  5-min budget deadline ~08:20:45, but the arbiter would not press Enter while the
  worker was busy, so `submitAttempts === 0` at the deadline and it escalated and
  stopped. The findings were ultimately delivered by an **operator pressing Enter
  manually** — confirming the action itself was always safe and effective; only
  the arbiter's refusal to perform it blocked delivery.

So the real defect is not a budget-vs-idle-window race. It is: **(1)** the
arbiter refuses to act while busy (`isSessionStreaming` → `noop`), when acting is
safe; **(2)** it gives up on a wall-clock timer rather than on exhausted
consumption-verified retries.

Two honest residual unknowns this spec must treat as load-bearing, not assume
away:

- **Manual vs programmatic Enter.** The opk-61 proof is a *manual* Enter. The
  arbiter's dispatch is `tmux send-keys -t <pane> Enter` (the same keystroke
  injection) — mechanically identical, but the manual live-smoke (below) must
  confirm the programmatic path enqueues-and-is-consumed identically before this
  is trusted in production.
- **Runtime-dependent queue behavior.** opk-61 is a **Codex** worker. #281's
  original bracketed-paste root cause was a **Cursor-CLI** idle worker (a single
  trailing Enter is absorbed by the still-settling paste). Different runtimes may
  enqueue/absorb Enter differently. The fix must therefore be **verification-
  driven** (press, then confirm consumption, retry if not) — never
  *assume-once-and-done* for any runtime.

## Binding surface

What this issue commits the repository to (contracts; implementation, field
names, signatures, and the verification mechanism left to the planner):

- **First dispatch is unconditional on worker-busy state — for a smoke-enabled
  backend (the core fix).** For a delivery whose draft is authoritatively
  `draft_present`, **when busy-dispatch is enabled for that backend by a valid
  smoke marker** (see the smoke-gate bullet), the arbiter presses Enter whether or
  not the worker is streaming/busy: the `isSessionStreaming` →
  `noop reason=streaming` *blocking* gate from #232 is removed as a precondition.
  (On a busy worker this enqueues the submit; on an idle worker it submits; neither
  interrupts.) **On a backend without a valid busy-smoke marker, the first dispatch
  is unconditional only on the *idle* state** (the prior #232-safe path) — busy
  dispatch is *not* planned. This `busy_dispatch_allowed` capability is an explicit
  state, not an implicit default, so "unconditional on busy" never silently applies
  to an unproven backend.
- **Retry is driven by consumption verification, not a pre-dispatch budget.**
  After a dispatch, the arbiter determines — from AO state/events, never pane
  scraping — whether the draft was consumed. The original *pre-dispatch* wall-clock
  budget (the one that escalated `submitAttempts === 0` because a busy worker
  consumed it before the first Enter) is removed; a busy worker can no longer
  block the first attempt. (A **delivery-anchored** terminal backstop survives —
  see below — so the removal does not reintroduce a silent-forever path, even when
  no first Enter ever happens.)
- **The "outcome observable" boundary requires a *settled* signal, not merely an
  idle-looking transition.** Single-flight correctness depends on knowing when a
  dispatched Enter can no longer later be consumed. The dangerous race is **not**
  only "worker still busy": a backend can transition to an idle-/observable-looking
  AO state **before the queued Enter has flushed** and before consumption is
  reflected — and treating that early state as "not-consumed-at-observable-point"
  would issue a **second** Enter against a still-pending queued submit (a real-TUI
  double-submit that synthetic fixtures would miss). So the spec requires a
  **defined, deterministic** observability predicate over AO state/events that
  includes a **stable post-flush / drain-settled** condition (e.g. the relevant AO
  state stable across a settle window, or a positive flush signal) before a
  re-dispatch is permitted (the planner owns *which* AO signal/transition; the
  contract is that it is explicit and settle-aware, not a per-tick guess). Explicit
  **negative** case — when observability cannot be determined or has not settled
  (worker still busy, signal absent/ambiguous, idle-but-not-yet-drained, runtime
  cannot expose consumption), the outcome **stays pending and the arbiter does not
  re-dispatch** (fail-closed against double-submit), riding to the post-dispatch
  backstop rather than guessing or branching per runtime.
- **Single-flight is per-delivery, with at most one outstanding dispatch, counted
  against a durable write-ahead phase.** The arbiter must **not** stack Enters on a
  busy worker. After dispatching, it does not re-dispatch until the prior
  dispatch's outcome is **observable** (the worker has reached a point where
  consumption of that draft would be detectable) and shows non-consumption with
  the same draft still present. This prevents a queued Enter plus a later
  re-dispatched Enter from double-submitting when the turn ends. The **attempt cap
  is counted against a single durable phase committed write-ahead of the external
  tmux send** (the `dispatch-attempted` phase of #281's three-phase accounting) —
  not against planned-but-uncommitted ticks or post-send observations — so a crash
  cannot under- or over-count attempts. On recovery from a
  **committed-but-unknown-send** outcome (crash between the durable
  `dispatch-attempted` commit and confirmation), the arbiter **fails closed: it
  does not issue another Enter until the outcome is observable** (treats the prior
  send as possibly-landed), preserving single-flight across the crash.
- **Re-dispatch is gated on content freshness, proven by a metadata-only draft
  identity — strength bounded by what AO exposes.** The arbiter re-Enters only
  when **this** delivery's draft is still authoritatively `draft_present` and
  **unchanged**. "Unchanged" must rest on a **stable, metadata-only draft
  identity** (e.g. an AO-carried delivery id and/or a draft fingerprint/hash
  derived without pane-scraping or payload persistence — planner's choice, but it
  must be content-bound, not a shape-only "something is in the input" check)
  sufficient to distinguish *this delivery's untouched draft* from operator-typed,
  changed, or foreign content. **Feasibility gate:** if the existing AO surface
  cannot expose a content-bound identity within scope (no pane-scraping, no
  payload persistence), the arbiter must **fail closed on shape-ambiguous input**
  — it does **not** re-dispatch when it cannot prove the present input is exactly
  this delivery's draft (it rides to the backstop instead of guessing) — and a
  stronger identity is the upstream AO delivery-id-echo dependency already tracked
  out-of-scope (#232/#281), not something this issue fabricates from pane text. A
  bare shape check is explicitly insufficient. **This identity/freshness gate
  binds the *first* dispatch too, not only re-dispatch:** if at first-dispatch time
  the input is already stale / intervening-operator / shape-identical-foreign / not
  this delivery's `draft_present`, the arbiter must **not** press the first Enter
  (especially on the busy path) — it classifies per the state machine, never
  submits the wrong content.
- **Every tracked delivery has a delivery-anchored terminal backstop — even with
  zero dispatches.** The "never silent forever" guarantee must **not** depend on a
  first Enter ever happening. A finite, operator-overridable backstop measured
  **from delivery** forces an operator-visible terminal escalation for any tracked
  delivery that is never consumed — including the **busy-dispatch-disabled /
  default-off** path and any worker that never reaches a dispatchable state — so a
  draft on a busy worker cannot sit unbounded and invisible (the opk-58 class)
  merely because busy dispatch is gated off. This delivery-anchored bound only
  forces a **visible** escalation; it never silently abandons or blocks retry (the
  two properties whose absence was the original bug — not the existence of a
  wall-clock bound itself).
- **Bounded retry with a liveness-aware post-dispatch lease (the inner bound for
  the enabled path).** When busy dispatch is enabled and a first Enter has been
  sent, retries are additionally bounded by a finite attempt cap and a
  **post-dispatch lease** (max pending age from first dispatch). Because observable
  retry opportunities may **never arrive** (a worker that stays busy or hangs
  forever after the first dispatch), the lease forces an **operator-visible
  terminal escalation even with zero observable retry opportunities and without
  re-dispatching** — closing the alive-but-indefinitely-busy limbo. **The backstop
  must distinguish a hung worker from a legitimately long turn:** the lease is
  extended while the worker shows accepted progress/liveness, and terminal
  escalation fires only when the age cap is exceeded **and** no progress signal is
  extending the lease — so a long but live tool call / review turn whose queued
  Enter will still be consumed is **not** falsely escalated. **The progress
  extension is itself bounded:** the **delivery-anchored** backstop is an absolute
  ceiling that liveness/progress **cannot** extend past — a worker emitting
  low-value heartbeats forever cannot keep a queued Enter pending indefinitely; at
  the ceiling the delivery reaches a failed terminal ("still-live-but-unconsumed",
  operator-visible, **without** re-dispatching), so "never silent forever" holds on
  the enabled path too. (This backstop differs
  from the removed pre-dispatch budget: it starts only *after* the first Enter is
  sent, so it never causes the `submitAttempts === 0` abandonment that was the
  original bug.) On exhaustion of the attempt cap, the post-dispatch lease, or the
  delivery-anchored backstop the delivery reaches a **truly terminal** state;
  together with the delivery-anchored backstop above this preserves #281's "never
  silent forever" guarantee on every path. Overrides validated fail-closed
  (non-finite / zero / negative
  / exceeding the maximum the **#281 override validator already enforces** →
  `config_invalid` escalation before tracking; this issue reuses that validation
  policy and bound, it does not define a new numeric threshold).
- **Terminal is a durable tombstone; late consumption reconciles to `consumed`.**
  A terminal escalation does **not** leave the still-present physical draft to be
  reclassified as a fresh delivery. The arbiter writes a **durable terminal
  tombstone keyed by `delivery_id` / draft identity** so that future ticks, a
  restarted arbiter, or a later reconciler recognize the stale draft and neither
  re-Enter it nor treat it as a new delivery — it awaits explicit operator
  disposition. Because single-flight already guaranteed at most one outstanding
  Enter, if a previously-queued Enter is **later observed consumed after** a
  backstop/cap escalation, the delivery is **reconciled to `consumed`** and the
  escalation marked resolved (never a second submit) — resolving the
  "terminal-then-actually-submitted" contradiction. **Precedence rule:** actual
  consumption is **ground truth** — if a delivery was `operator_disposed` (waived)
  and its still-queued Enter is **later observed consumed**, the terminal
  reconciles to `consumed` (the feedback genuinely reached the worker), while the
  audit history **retains** the prior waiver (trail shows "waived, then actually
  delivered"); the waiver is never silently erased, and downstream reads `consumed`
  deterministically regardless of observation timing.
- **Escalation is operator-visible *and durable*, not log-only or transient.** When
  retries are exhausted (terminal) the arbiter surfaces the stuck delivery on the
  existing supervised operator-visible escalation channel (#205/#281), **idempotent
  by `delivery_id`** (no per-tick spam), and it does **not** mutate GitHub Issue /
  task state. A pure log line is insufficient — opk-57/58 were invisible precisely
  because escalation was log-only. The escalation must also be **durable / queryable
  across a supervisor restart** (it is backed by the durable failed-delivery record
  below, not only a transient channel emission or terminal scrollback), and the
  **dedup is acknowledgement/persistence-aware**: it suppresses re-emission only
  after the surface has durably recorded the escalation, and **re-surfaces** if a
  prior emission was lost before that durable record — so dedup can never recreate
  the opk-57/58 invisibility.
- **Every failed-delivery terminal emits a durable machine-readable signal
  downstream gates can consume.** Beyond the operator channel, **any** failed
  terminal (every terminal that is not `consumed` / `operator_disposed`, per the
  state machine above — including the draft-absent/changed path) writes a
  **durable, machine-readable failed-delivery status** keyed by `delivery_id` (and,
  where known, the PR/review run) so that orchestration / review-merge gating can
  avoid treating undelivered reviewer feedback as delivered (a
  reviewer-false-approval / stale-Issue-state class). **A reviewer-finding delivery
  must carry its PR/review-run identity at tracking time** (fail-closed: if it
  cannot be attributed to a PR/review-run, it is not silently tracked as an
  unscoped record the PR-scoped query would miss); and the read surface **fails
  closed on any unscoped/unknown-scope unresolved record that matches the current
  run by a deterministic association predicate** built on **durable run/delivery
  identity** — same repo/state-root + PR/review-run linkage + unresolved state,
  associated by a **durable run/delivery sequence (or monotonic journal ordering),
  not raw wall-clock** (WSL/Windows clock skew, suspend/resume, or manual clock
  changes must not mis-associate; wall-clock is display metadata only). Mandatory
  PR-scoping-at-tracking (above) makes a truly unknown-scope *reviewer-finding*
  record a fail-closed tracking error rather than a query-time guess, so the
  association predicate is a backstop, not the primary mechanism. This issue
  **emits and owns** that signal **and a minimal in-scope read surface**: a
  queryable status/preflight (e.g. an `ao`-side or arbiter status check) that
  reports **unresolved failed-delivery records for the current PR/review-run**.
  Adoption is conditional on that read surface; the **full automated merge-block
  wiring** remains the review/merge gate's obligation (#163/#189/#207, otherwise
  out-of-scope here). Emission alone is insufficient — without the visible,
  fail-closed read surface the reviewer-false-approval class is only relocated, not
  closed. Still **no** direct GitHub Issue/task mutation.
- **Failed-delivery records resolve atomically on success.** When a previously
  failed delivery is later `consumed` or audited `operator_disposed`, its
  failed-delivery record is **atomically, idempotently resolved** — excluded from
  the unresolved read surface while its **audit history is preserved** — with no
  inconsistent mid-resolution read (a downstream gate never blocks forever on a
  stale unresolved record, nor reads clean during a partial resolution).
- **Failed-delivery records have an explicit retention lifecycle.** A record is
  **scoped to its own PR/review-run** and therefore never blocks an *unrelated*
  run. When its PR is **closed** or its review-run is **superseded**, the record is
  **audited-closed** (a recorded lifecycle transition), **not silently dropped** —
  silently dropping an unresolved failure would recreate reviewer false approval,
  while leaving it live forever would deadlock later runs. **But supersession alone
  must not auto-close an unresolved *reviewer-finding* record** (a mechanically
  superseded run — e.g. head advanced — would otherwise bury the undelivered finding
  without anyone confirming it was addressed): audited-closure of such a record
  requires **either** a machine-checkable link proving the superseding run
  **obsoletes / re-covers the same finding**, **or** an attributed
  `operator_disposed` waiver — otherwise the unresolved finding **carries forward**
  (re-associated to the live run) and keeps blocking. **Closed-PR audited-closure
  is inactive-only, reversible on reopen:** a PR close is not necessarily final, so
  an unresolved reviewer-finding record audited-closed on PR close must
  **reactivate** if the PR is reopened/reused — unless it is by then `consumed`,
  re-covered, or `operator_disposed` — so a temporary close cannot make the PR
  mergeable with the finding silently buried. **State-root cleanup /
  rotation / worktree deletion must preserve unresolved records** (or require an
  audited operator disposition before removal); GC may reap only **resolved /
  audited-closed** records. The planner owns storage location and the GC mechanism;
  the contract is "never silently lose an unresolved failure, never let a dead
  PR's record block a live unrelated one."
- **Delivery state machine: only two *successful* terminals.** A delivery
  terminates as **success** only on `consumed` or `operator_disposed`. **Every
  other** terminal close — draft absent/changed before confirmed consumption (the
  finding vanished/was overwritten), the delivery-anchored backstop, the
  post-dispatch lease, the attempt cap, worker dead/gone, or unresolved ambiguity —
  is a **failed-delivery** terminal: it writes the durable failed-delivery
  tombstone (below) **and** an operator-visible escalation, and downstream
  review/merge gating must treat it as **unresolved** until the delivery is later
  `consumed` or explicitly `operator_disposed`. No terminal close is silently
  treated as success, and no intermediate state silently stops retrying while the
  worker is alive and the draft is still present. This closes the
  reviewer-false-approval-via-alternate-terminal-path class (e.g. a finding draft
  that disappears is **not** a success).
- **`operator_disposed` is an audited waiver, not a silent success.** Because
  `operator_disposed` is a *successful* terminal for an undelivered finding, it
  must be a **durable, idempotent, operator-initiated, reasoned waiver** keyed to
  the same delivery identity + PR/review-run, recording **actor, time, and source**
  — never an auto-set or unattributed close. Downstream gates must be able to
  distinguish `operator_disposed` (feedback **deliberately waived** while
  undelivered) from `consumed` (feedback **delivered**); they are **not**
  interchangeable for review-integrity purposes. The disposition carries **no
  payload** (metadata-only per #281), and its **`reason` is sanitized metadata** —
  a bounded category/enum plus an optional short redacted note, subject to the
  **same no-raw-payload / no-terminal-transcript / no-session-URL / no-secret
  checks as the smoke evidence** — since these waiver records are durable and
  downstream-readable, a free-form reason quoting the undelivered finding, terminal
  text, a session URL, or a credential would be a side-channel leak.
- **All #281/#232/#216 invariants preserved.** No pane-text scraping; decisions
  are state/event-derived. Fail-closed on ambiguity (multiple in-flight deliveries
  to one session with no AO-carried delivery id → stays unconfirmed, no false
  submit). Never submit a `send_failed` delivery; never Enter a non-`draft_present`
  (`unknown`/`auto_submitted`) shape; never replay a payload (only re-Enter an
  AO-observably-present draft). The crash-safe three-phase accounting (claim /
  dispatch-attempted / outcome) and durable active-delivery record (atomic write,
  quarantine-on-corruption, parse-failure escalation, state-root identity) hold
  across re-dispatch and supervisor restart.
- **Busy-state dispatch is gated per submit-backend on a machine-checkable smoke
  marker (fail-closed default).** Because the entire behavioral change rests on the
  programmatic-`tmux send-keys Enter`-on-a-busy-worker assumption — proven only for
  the **Codex** backend so far, and queue/absorb behavior is backend-dependent —
  busy-state dispatch must **not** be enabled for a worker backend / submit
  session-type unless that backend has a **recorded, sanitized smoke-evidence
  marker** (machine-readable, metadata-only per #281 — not a free-text "we
  documented a procedure"). The gate is therefore:
  - **Gates *busy* dispatch only — idle dispatch is unaffected.** The smoke gate
    governs **only** the new busy-state dispatch. The pre-existing idle-only
    dispatch (#232's already-safe behavior) is **not** disabled for any backend: an
    unproven/unknown backend still dispatches one Enter when the worker becomes
    **idle** with the same `draft_present`, and only relies on the
    **delivery-anchored** backstop if it never idles. An unproven backend must
    **not** be forced to escalate-only while a perfectly deliverable idle window
    exists.
  - **Per-backend, not global.** A Codex-only smoke marker does **not** enable busy
    dispatch for an unproven backend (e.g. Cursor-CLI); that backend stays on the
    idle-only path above + the bounded backstop. This is the *enablement* gate keyed
    to the validated backend — **not** the per-runtime consumption *capability
    matrix* that was rejected (which would re-couple the decision logic #232 made
    source-agnostic).
  - **Machine-checkable, fail-closed — CI mandatory, preflight additional.**
    Enabling busy dispatch for a backend without its smoke marker is a **fail-closed
    error**. The **CI** marker-schema / staleness / default-off validation is
    **mandatory** (a PR that ships a bad/missing/stale-validator marker fails CI);
    the startup **preflight** refusal is an **additional** runtime guard, **not** an
    alternative to CI (the `and/or` escape — CI-skipped, caught only when an operator
    starts the arbiter — is disallowed; that would re-open the
    reviewer-false-approval / silent-status-transition class). Synthetic fixtures
    cannot observe the live TUI reaction, so this marker is the only thing standing
    between the assumption and a regression (stuck-again / wrong-time-submit /
    backend-specific double-submit).
  - **Marker must be auditable, not a bare boolean, and bind the behavior it
    proves.** A `backend=true` flag is insufficient. The marker must bind, at
    minimum: the **backend key**; a **dispatch-implementation version/signature**
    (our adapter); the **observed worker backend/TUI/runtime version** (and relevant
    tmux/runtime config) the busy-enqueue behavior was actually smoked against — the
    load-bearing assumption is the *worker TUI* treating busy Enter as an enqueue,
    not just our adapter sending it, so a Codex/Cursor/TUI/tmux upgrade **or the
    relevant tmux version/config/send-keys behavior** changing while backend/TUI
    versions stay the same must **invalidate the marker (fail closed) until
    re-proven** (the proof binds the *full input path*, tmux included); the
    **observed-behavior evidence as bounded flags** — both
    `busy_enter_enqueued_observed=true` **and `consumed_after_flush_observed=true`
    with `no_manual_enter=true`** (the load-bearing behavior is not just the enqueue
    cue but that the queued submit is later *flushed and consumed* with no manual
    Enter; an enqueue-only marker is insufficient and fails schema validation) —
    **not** captured terminal text: the operator *observes* the TUI cues (the
    "submitted after next tool call" enqueue cue and the subsequent consumption) but
    **records only the flags + versions**, never the transcript (the secret-safety
    ban stands); and **provenance** (smoke timestamp + sanitized run id,
    metadata-only per #281). The CI/preflight check validates these and **fails
    closed when the running environment's backend/TUI/runtime/tmux is unknown or
    differs from the smoked one** (planner owns the marker's location, exact fields,
    and the signature/version mechanism).
  - **Capability change mid-delivery is an audited transition, not a silent
    switch.** If `busy_dispatch_allowed` flips **false** while a delivery is already
    active (marker invalidated by a backend/TUI/runtime/config change before first
    dispatch or before a retry), the arbiter: (a) issues **no new busy Enters** for
    that delivery; (b) **preserves single-flight** for any already-outstanding Enter
    (never abandons or duplicates it); (c) falls back to the idle-only path + the
    delivery-anchored backstop; and (d) **records the capability transition in
    audit** so any resulting failed terminal has a clear reason. The active delivery
    is never left running under stale busy-dispatch assumptions.
- **Operator adoption.** If the bounded-cap, the smoke gate, or the
  operator-visible escalation needs a new env knob or wiring, document its safe
  default and the post-PR operator steps (yaml merge / `ao stop` / `ao start` /
  env). If no operator-facing surface changes, state that explicitly.

## Files in scope

- The existing supervised submit-reconcile arbiter, extended **in place**. It is
  **three distinct existing components** that together form the arbiter — all in
  scope, none authoritative-on-its-own:
  - the supervised **PowerShell host** that runs each tick (the
    `scripts/worker-message-submit-reconcile.ps1` entrypoint exercised by the
    `-Once -DryRun` verification),
  - its **dispatch adapter** under `scripts/lib/**` that issues the actual
    `tmux send-keys … Enter` (the `Submit-WorkerInputDraft.ps1`-style adapter),
  - the **decision helper / mechanical node filter** under `docs/`
    (`worker-message-submit-reconcile`) carrying the `plan`/`outcome` logic.

  In scope across these: removing the busy-blocks-dispatch gate, the
  consumption-driven retry + per-delivery single-flight (one outstanding dispatch),
  the freshness re-dispatch gate, the bounded caps/backstops, the failed-delivery
  signal, the per-backend smoke gate, and the operator-visible escalation emission
  (planner owns names, signatures, layout, and the verification mechanism — extend
  the current files, don't relocate them).
- `scripts/fixtures/**` `(new)` — fixtures for the scenario-matrix cells below.
- `docs/orchestrator-recovery-runbook.md` — operator note on dispatch-while-busy,
  the consumption-driven retry, the operator-visible terminal escalation, and how
  to read it.
- `agent-orchestrator.yaml.example` and `prompts/agent_rules.md` — **only if** a
  documented operator env knob or wiring is introduced.
- `docs/issues_drafts/00-architecture-decisions.md` — decision-log entry for
  dropping the busy-refusal and the wall-clock delivery budget in favor of
  dispatch-regardless + consumption-driven retry (synced to Issue #3 in the same
  PR).

## Files out of scope

- AO core (`@aoagents/ao-core`) — the single-trailing-Enter bracketed-paste
  behavior and any delivery-id echo are upstream (#232/#281 already track this).
- Flood detection (#173), review trigger/coverage (#163/#189/#207), worker
  lifecycle (spawn/`--claim-pr`/kill), and the worktree-drift vanish class — all
  consumed as signals only, not changed here.
- Pane-text scraping for content/draft verification — explicitly excluded.
- GitHub Issue / task-state mutation on delivery escalation.
- `packages/core/**`, `vendor/**`, `.ao/**`.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

Policy logic is fixture-driven on the decision helper (sibling of the existing
`worker-message-submit-reconcile.test.ts`), each a discrete fixture + state
assertion over synthetic AO-status / events / tracking input — no live tmux. The
live Codex paste/Enter integration is covered by the documented manual smoke
check, not a CI gate (carries #281's split).

```positive-outcome
asserts: given a delivery whose draft is authoritatively draft_present while the worker is streaming/busy on a smoke-enabled backend (busy_dispatch_allowed), the arbiter plans an Enter dispatch (does not noop on streaming), and after a synthetic non-consumption with the same draft still present at a settled observable point, plans exactly one re-dispatch — never two outstanding dispatches
input: realistic
```

1. **Dispatch regardless of busy — only on a smoke-enabled backend.** A fixture
   where the worker is streaming/busy, the draft is `draft_present`, **and
   `busy_dispatch_allowed` is true for the backend** → the arbiter plans an Enter
   dispatch; it does **not** emit `noop reason=streaming`. A paired fixture with
   the **same** busy state but `busy_dispatch_allowed` **false** (no valid marker)
   → the arbiter does **not** plan a busy-state Enter (it waits for idle / rides
   the backstop). The prior wall-clock "budget expired with zero attempts" path is
   gone for the enabled backend.
2. **Consumption-driven retry, single outstanding dispatch, drain-settle aware.** A
   fixture where one dispatch occurred and the worker is still busy (outcome not
   yet observable) → no re-dispatch. When the worker reaches a **settled** observable
   point with the draft consumed → terminal `consumed`, no further Enter. When it
   reaches a **settled** observable point with the **same** draft still present
   (absorbed/lost) → exactly one re-dispatch. **Plus a drain-lag negative fixture:**
   the AO state looks idle/observable but the queued submit has **not yet drained/
   settled** → the arbiter does **not** re-dispatch (no second Enter against a
   still-pending queued submit).
3. **Observability-indeterminate fails closed (source-agnostic).** A fixture where
   consumption cannot be determined for this delivery (signal absent/ambiguous, or
   a runtime that cannot expose consumption) → the outcome stays pending, the
   arbiter does **not** re-dispatch, and the delivery rides to the post-dispatch
   backstop (no per-runtime branch, no guess-driven double-submit).
4. **Freshness/identity-gated dispatch — first dispatch *and* re-dispatch.** A
   fixture where the input changed / intervening operator input arrived / the draft
   is no longer `draft_present` for this delivery → no dispatch (fail-closed).
   Includes a **negative-identity** fixture (operator-typed shape-identical input
   that is **not** this delivery's draft → no submit) and an **identity-unprovable**
   fixture (AO exposes only shape → treated as unprovable → no dispatch, rides the
   backstop). Crucially, **paired pre-first-dispatch** fixtures: stale / intervening
   / shape-identical-foreign input present **before any Enter** on **both** the
   smoke-enabled **busy** path **and** the smoke-disabled **idle-only** path → the
   arbiter does **not** press the first Enter and classifies per the state machine —
   never a first-Enter against the wrong content on either path.
5. **Bounded terminal escalation, operator-visible.** A fixture where the draft is
   never consumed across the bounded retries → the delivery reaches a **truly
   terminal** state at the finite cap and emits exactly one operator-visible
   escalation per `delivery_id` (dedup across ticks), routed to the supervised
   escalation channel, **not** mutating GitHub Issue/task state. A fixture with a
   non-finite / disabled / zero / negative override of the cap — or one exceeding
   the maximum the **#281 override validator already enforces** — escalates
   `config_invalid` before tracking.
6. **Liveness-aware backstop closes busy-forever limbo without false escalation,
   and progress extension is itself bounded.** A fixture where the worker is
   **hung** after the first dispatch (no progress signal, no observable retry
   opportunity, draft still present) → at the post-dispatch lease the delivery
   reaches a **truly terminal** failed state with exactly one operator-visible
   escalation, **without** any re-dispatch. A fixture where the worker is
   **legitimately busy** past the raw age cap but **still emitting
   progress/liveness** → the lease is extended and the delivery is **not** falsely
   escalated. And a **heartbeat-forever** fixture: progress continues indefinitely
   but the draft is never consumed → at the **delivery-anchored ceiling** (which
   progress cannot extend past) the delivery reaches a `still-live-but-unconsumed`
   failed terminal, operator-visible, **without** re-dispatch.
6a. **Delivery-anchored backstop bounds the zero-dispatch path.** A fixture where
    busy dispatch is **disabled** (no smoke marker for this backend) and the worker
    stays busy with `draft_present` so **no first Enter is ever sent** → the
    delivery still reaches a **truly terminal**, operator-visible escalation at the
    finite **delivery-anchored** backstop (it is not abandoned silently merely
    because busy dispatch is gated off — the opk-58 class cannot recur on the
    default-off path).
7. **Late consumption after terminal reconciles to `consumed`.** A fixture where a
   backstop/cap escalation already fired and then the previously-queued Enter is
   observed consumed → the delivery is reconciled to `consumed`, the escalation
   marked resolved, and **no second Enter** is issued (single-flight held across
   the contradiction).
8. **Terminal tombstone, no reclassification.** A fixture where a terminal delivery
   still has its physical draft present on a later tick / after a simulated
   restart → the durable tombstone (keyed by `delivery_id` / draft identity) makes
   the arbiter recognize it, **not** re-Enter it, and **not** treat it as a fresh
   delivery; it awaits operator disposition.
9. **Attempt-cap crash accounting.** Fixtures proving the cap is counted against
   the durable `dispatch-attempted` phase committed write-ahead of the external
   send: a crash between commit and send-confirmation recovers **fail-closed** (no
   second Enter until observable), and the cap neither under-counts (stacking
   Enters) nor over-counts (escalating without real attempts).
10. **State machine: success vs failed terminals.** Fixtures proving the only
    **successful** terminals are `consumed` and `operator_disposed`, and that
    **every** other terminal — draft absent/changed before consumption, worker
    dead/gone, attempt cap, post-dispatch lease, delivery-anchored backstop/ceiling,
    unresolved ambiguity — is a **failed-delivery** terminal that emits the durable
    failed-delivery signal (AC 17) + operator-visible escalation and is consumable
    downstream as **unresolved**. Includes an explicit **draft-absent/changed-
    before-consumption** fixture proving it is classified *failed*, not success.
    Being busy alone never causes a terminal stop *before* a bound while the draft
    is present.
11. **Fail-closed ambiguity preserved.** With two in-flight deliveries to one
    session and no AO-carried delivery id, the arbiter does **not** falsely
    submit/confirm either (stays unconfirmed; rides to bounded escalation).
12. **Single-flight under concurrency/restart.** A two-runner / restarted-
    supervisor fixture over a busy-enqueued delivery proves ≤ 1 outstanding
    dispatch per `delivery_id` — a queued Enter plus a re-dispatch never
    double-submit.
13. **Invariant preservation.** Fixtures proving the arbiter never submits a
    `send_failed` delivery, never Enters a non-`draft_present` (`unknown` /
    `auto_submitted`) shape, never replays a payload (only re-Enters an
    AO-observably-present draft), and reads no pane text.
14. **Dispatch-mechanics contract (deterministic, non-live).** A repeatable
    (non-live-worker) test of the programmatic dispatch construction: it targets
    the resolved pane for this `delivery_id`, sends a **single** Enter (no stacked
    keys), and carries **no payload on the command line / argv** (per #281
    secret-safety). This guards the programmatic path against regression
    independently of the manual TUI-reaction smoke.
15. **Crash-safe across re-dispatch.** The three-phase accounting (claim /
    dispatch-attempted / outcome) and durable active-delivery record hold across a
    crash between a dispatch and its outcome — recovery does not double-Enter and
    does not lose the delivery.
16. **Busy-state dispatch gated per-backend on an auditable machine-checkable smoke
    marker; idle dispatch unaffected.** Enabling busy-state dispatch for a worker
    backend without that backend's recorded, sanitized smoke marker is a
    **fail-closed error**: the **CI marker validation refuses (mandatory), and the
    startup preflight also refuses at runtime** — preflight is an *additional* guard,
    never a substitute (no "and/or" escape). It is not satisfiable by documentation
    alone, and a bare `backend=true` boolean is rejected. The marker binds backend
    key + dispatch-implementation version/signature + **observed backend/TUI/runtime
    version + relevant tmux version/config** + provenance; fixtures prove a **stale
    marker** — whether *our* dispatch signature, the *backend/TUI/runtime* version,
    **or the tmux version/config/send-keys behavior** changed since the smoke —
    re-disables busy dispatch (fail-closed) until re-proven, and that an
    unknown/differing running environment fails closed. A Codex-marker fixture proves
    busy dispatch enabled for Codex but an unproven backend (e.g. Cursor-CLI) stays
    off busy dispatch. The default-off path is fixture-proven (gate unset → no
    busy-state Enter, delivery still bounded per AC 6a). The recorded evidence is
    **bounded flags (`busy_enter_enqueued_observed` + `consumed_after_flush_observed`
    + `no_manual_enter`) + backend/TUI/tmux versions**, never captured terminal text.
16a. **Unproven backend still delivers on idle (no idle regression).** A fixture
    where a backend has **no** busy-smoke marker, a delivery arrives while the
    worker is busy, and the worker **later becomes idle** with the unchanged draft
    → exactly one **idle** Enter is dispatched (the prior #232-safe path), **not**
    forced to wait for the delivery-anchored backstop. The smoke gate must not
    disable pre-existing idle delivery.
16b. **Capability change mid-delivery is an audited transition.** A fixture where
    `busy_dispatch_allowed` flips false on an **active** delivery (stale marker
    mid-flight) → no new busy Enter, any outstanding Enter keeps single-flight
    (not abandoned/duplicated), the delivery falls back to idle-path + backstop, and
    the capability transition is recorded in audit (a resulting failed terminal has
    a clear reason).
16c. **Durable, restart-surviving escalation with ack-aware dedup.** A fixture/
    dry-run proving a terminal escalation is **queryable after a supervisor
    restart** (backed by the durable failed-delivery record, not transient
    scrollback), and that dedup **re-surfaces** an escalation whose prior emission
    was lost before durable recording/acknowledgement (dedup never recreates
    opk-57/58 invisibility).
17. **Failed-delivery signal is durable + machine-readable, on every failed
    terminal, with a fail-closed read surface.** A fixture proving **each**
    failed-delivery terminal (per AC 10, including draft-absent/changed) writes a
    durable, machine-readable failed-delivery status keyed by `delivery_id`,
    **without** mutating GitHub Issue/task state. A **reviewer-finding** delivery
    that cannot be attributed to a PR/review-run is **not** tracked as an unscoped
    record (fail-closed at tracking). Plus a read-surface fixture: a
    status/preflight query returns the unresolved records for a given PR/review-run
    **and fails closed on any unscoped/unknown-scope unresolved record** matched by
    the deterministic durable-identity association predicate (never reads clean past
    an unattributable failure).
17a. **Failed-delivery records resolve atomically, with deterministic waiver-vs-
    consumed precedence.** A fixture proving that a late `consumed` or audited
    `operator_disposed` **atomically, idempotently** resolves the failed-delivery
    record (excluded from the unresolved query, **audit history preserved**), with
    no inconsistent mid-resolution read. Plus a **precedence** fixture: a delivery
    `operator_disposed` (waived) whose still-queued Enter is **later observed
    consumed** → reconciles to `consumed` (ground truth), the prior waiver retained
    in audit, downstream reads `consumed` regardless of observation timing.
17b. **`operator_disposed` is an audited, sanitized waiver.** A fixture proving
    `operator_disposed` is durable, idempotent, **operator-initiated with recorded
    actor/time/source**, keyed to the delivery identity + PR/review-run,
    operator-visible, carries no payload, and is **downstream-distinguishable** from
    `consumed`. An unattributed / auto-set disposition is rejected. Plus a
    **reason-sanitization** fixture: a `reason` containing raw payload / terminal
    transcript / session URL / secret is rejected (same checks as smoke evidence) —
    only a bounded category + redacted note is accepted.
17c. **Failed-delivery record retention lifecycle.** Fixtures proving: a record is
    scoped so it never blocks an **unrelated** PR/run; a **closed PR** transitions
    the record to **audited-closed** (recorded), not silently dropped; **state-root
    cleanup / rotation / worktree deletion preserves unresolved records** (or
    requires an audited disposition first); and GC reaps only resolved/audited-closed
    records — never silently losing an unresolved failure. **Plus a
    supersession-bypass fixture:** a mechanically **superseded** run does **not**
    auto-close an unresolved **reviewer-finding** record unless a machine-checkable
    obsolescence/re-coverage link **or** an attributed `operator_disposed` waiver is
    present — otherwise the finding **carries forward** and keeps blocking. **And a
    PR-reopen fixture:** a record audited-closed on PR close **reactivates** when the
    PR is reopened/reused (unless by then consumed / re-covered / `operator_disposed`)
    — a temporary close cannot bury the finding.
17d. **Association robust to clock skew.** A fixture proving the unresolved-record
    association uses durable run/delivery **sequence / monotonic ordering**, so a
    wall-clock skew / suspend-resume / restart does **not** mis-associate a failure
    with the wrong run nor fail to associate the correct one.
18. **Scenario-matrix coverage (fix the class).** The equivalence-class outcomes
    enumerated in the matrix below are the **complete required coverage** — each
    is a mandatory fixture, and no cells beyond those listed are required.
19. **Operator docs + decision log.** Runbook documents dispatch-while-busy, the
    consumption-driven retry, the delivery-anchored + liveness-aware backstops, the
    per-backend smoke gate (incl. mid-delivery capability change), the terminal
    tombstone + late-consume reconciliation, the durable failed-delivery signal +
    its retention lifecycle (closed/superseded PR, cleanup), and the durable
    operator-visible terminal escalation; `00-architecture-decisions.md` records
    dropping the busy-refusal + pre-dispatch budget, synced to Issue #3 in the same
    PR. Manual live-smoke
    procedure documented (sanitized, metadata-only evidence per #281 — no terminal
    transcript, session URL, or raw body), and it **explicitly covers the
    programmatic `tmux send-keys Enter` on a busy worker** enqueuing-and-being-
    consumed (the load-bearing assumption that the deterministic AC 14 contract
    cannot fully prove without a live TUI).

### Scenario matrix (coherent cells only — fix the class, not opk-58)

Dimensions: **worker-state** × **dispatch-outcome** × **draft-state**.

- **worker-state** ∈ {streaming/busy, idle, intervening-input (`stale_input`),
  dead/gone}.
- **dispatch-outcome** ∈ {consumed-after-dispatch, enqueued-pending (busy, outcome
  not yet observable), idle-but-not-drained (AO looks observable but the queued
  submit has not settled), not-consumed-at-settled-observable-point (absorbed/lost —
  draft still present when consumption would be detectable), observability-
  indeterminate (signal absent/ambiguous or runtime cannot expose consumption),
  never-dispatchable}.
- **draft-state** ∈ {`draft_present`-unchanged, consumed, changed/absent,
  shape-identical-foreign (operator-typed, same shape, different draft identity)}.

Required equivalence-class outcomes:

- busy at delivery, `draft_present` → dispatch one Enter (enqueue) → worker
  finishes turn → consumed (**opk-57 / opk-58 / opk-61 class**) → no re-dispatch,
  no double-submit.
- busy at delivery → dispatch → outcome not yet observable (still busy) → **no**
  re-dispatch this tick (single outstanding dispatch).
- dispatched, worker reaches **settled** observable point, draft **still present**
  (absorbed) → exactly one re-dispatch (freshness ok) → consumed.
- dispatched, AO **idle-but-not-drained** (queued submit not yet settled) → **no**
  re-dispatch (avoids double-submit against a still-pending queued Enter).
- idle at delivery, `draft_present`, busy-dispatch may be off → dispatch (idle path
  works for any backend) → consumed.
- intervening operator input / draft changed after dispatch → no re-dispatch
  (freshness fail-closed; no blind Enter of foreign/changed content), and if it
  changed/vanished before confirmed consumption → **failed-delivery** terminal
  (durable signal + operator-visible), **not** success.
- shape-identical-foreign input (not this delivery's draft by metadata identity)
  → no submit (negative-identity guard).
- observability-indeterminate (signal absent / runtime can't expose consumption),
  `draft_present` → no re-dispatch, rides to the post-dispatch backstop
  (source-agnostic fail-closed).
- never consumed across bounded retries, `draft_present` throughout → bounded
  terminal escalation, operator-visible, at the attempt cap.
- busy-dispatch **disabled** (no smoke marker for this backend), worker busy,
  `draft_present`, never idles → still terminal + operator-visible at the
  **delivery-anchored** backstop (zero-dispatch path is bounded, not silent).
- busy-dispatch **disabled**, delivery arrives busy, worker **later idles** with
  unchanged draft → one **idle** Enter (prior #232-safe path), **not** forced to
  wait for the backstop (no idle-delivery regression).
- alive-but-**hung**-forever after first dispatch (no progress, no observable
  retry opportunity), `draft_present` → terminal at the **post-dispatch lease**,
  operator-visible, no re-dispatch (busy-forever limbo closed).
- alive-but-**legitimately-busy** past the raw age cap but still emitting
  progress/liveness, `draft_present` → lease extended, **not** falsely escalated
  (queued Enter still pending).
- **heartbeat-forever**: progress emitted indefinitely, never consumed,
  `draft_present` → at the **delivery-anchored ceiling** (progress cannot extend
  past it) → `still-live-but-unconsumed` **failed** terminal, operator-visible, no
  re-dispatch.
- terminal escalation already fired, then the queued Enter is later observed
  consumed → reconcile to `consumed`, escalation resolved, **no second Enter**.
- terminal delivery whose physical draft is still present on a later tick / after
  restart → tombstone recognized; **not** re-Entered, **not** reclassified as a
  fresh delivery; awaits operator disposition.
- worker dead/gone with pending draft → terminal escalation (no dispatch to a dead
  session).
- multiple in-flight deliveries, no delivery id → fail-closed ambiguity (no false
  submit), independent of dispatch-outcome.

## Upgrade-safety check

- No AO core / `vendor/**` / `packages/core/**` / `.ao/**` / dashboard edits; the
  bracketed-paste behavior and any delivery-id echo remain upstream.
- No unsupported `agent-orchestrator.yaml` schema fields; any live-config change
  is an operator-adopted `orchestratorRules` / env line, documented with safe
  defaults.
- No new repo secrets; no payload persistence (metadata-only journal and active
  record per #281 unchanged). **New durable surfaces are sanitized metadata-only:**
  the failed-delivery record, the per-backend smoke marker, and the
  `operator_disposed` waiver `reason` all pass the same no-raw-payload /
  no-terminal-transcript / no-session-URL / no-secret checks (the waiver reason is
  a bounded category + redacted note, not free text).
- The arbiter must fail closed (→ escalation, never a blind Enter, never a crash
  of the supervised tick) when AO status / consumption / draft-present signals are
  unavailable or ambiguous.
- Removing the busy-refusal must not weaken #281's bounded-escalation guarantee:
  the **delivery-anchored** backstop forces a finite, operator-visible terminal
  state on **every** path (including busy-dispatch-disabled / zero-dispatch), the
  post-dispatch lease + attempt cap bound the enabled path, and single-flight still
  guarantees no double-submit on a busy worker.
- The fail-closed busy-dispatch default must **not** combine with the removed
  pre-dispatch budget to create an unbounded zero-dispatch state — the
  delivery-anchored backstop closes that gap, proven by AC 6a.
- "Unconditional on busy" is scoped to a smoke-enabled backend
  (`busy_dispatch_allowed`); it must never apply to an unproven backend, and the
  observable predicate must be **drain-settle-aware** so an idle-but-not-flushed
  AO transition never triggers a second Enter.

## Decision log (to record in `00-architecture-decisions.md`)

#232 gated the arbiter on `isSessionStreaming` (no Enter while busy) and #281
bounded a single delivery by a wall-clock budget treated as terminal. Live
evidence (opk-61, 2026-06-13) shows Enter on a busy Codex worker safely
**enqueues** the submit (it does not interrupt — Esc does), and opk-57/58 show
the busy-refusal + wall-clock budget abandon deliverable findings with zero
submit attempts. Record: (a) the first Enter dispatch is unconditional on
worker-busy state **only for a smoke-enabled backend (`busy_dispatch_allowed`);
otherwise idle-only** — this is never a global "busy Enter always" rule; (b) retry
is driven by **consumption verification**, not a
wall-clock delivery budget a busy worker can run out; (c) single-flight is
per-delivery with at most one outstanding dispatch, so a queued Enter never
double-submits; (d) re-dispatch is gated on content freshness, not worker-
idleness; (e) escalation is bounded, terminal at a finite cap, and operator-
visible rather than log-only; (f) a **liveness-aware** absolute post-dispatch
backstop closes the alive-but-hung-forever case (extending the lease while the
worker progresses, so a long legitimate turn is not falsely escalated) so "never
silent forever" holds without reintroducing the pre-dispatch zero-attempt
abandonment; (g) terminal is a **durable tombstone** keyed by delivery identity so
a still-present draft is never reclassified as fresh, and a queued Enter consumed
**after** terminal reconciles to `consumed` (no second submit); (h) the attempt
cap is counted against the durable `dispatch-attempted` phase (write-ahead of the
external send) so crashes neither under- nor over-count; (i) a **delivery-anchored**
backstop bounds even the zero-dispatch / busy-dispatch-disabled path, so the
fail-closed default cannot recreate the opk-58 silent-stuck state; (j) busy-state
dispatch is enabled **per submit-backend** only behind a **machine-checkable**
sanitized smoke marker (CI/preflight fails closed otherwise), so a Codex-only proof
never silently enables an unproven backend and "adopted" cannot mean "documented";
(k) **every** failed terminal emits a **durable machine-readable** failed-delivery
signal a downstream review/merge gate can consume, so undelivered reviewer findings
are not treated as delivered (no GitHub mutation here); (l) the delivery is modeled
as a state machine whose **only successful terminals are `consumed` and
`operator_disposed`** — every other terminal (incl. draft-absent/changed before
consumption) is a *failed* delivery, closing the reviewer-false-approval-via-
alternate-terminal-path class; (m) liveness/progress extension is **bounded by the
delivery-anchored ceiling** (progress cannot defer escalation forever), and (n) the
per-backend smoke marker is auditable (backend + dispatch-signature + provenance) so
a stale marker after a dispatch-path **or backend/TUI/runtime** change re-disables
busy dispatch; (o) `operator_disposed` is an **audited, attributed, reason-
sanitized waiver** distinct downstream from `consumed`, not a silent success; (p)
the smoke gate governs **busy** dispatch only — pre-existing **idle** delivery is
preserved for every backend; (q) the failed-delivery signal ships with a minimal
in-scope **fail-closed read surface** (unresolved records per PR/review-run;
reviewer findings PR-scoped at tracking; resolved atomically on
consumed/operator_disposed), since emit-only would only relocate the
reviewer-false-approval class; (r) "unconditional on busy" is scoped to a
smoke-enabled backend and the observable predicate is **drain-settle-aware** to
avoid a double-submit against a still-pending queued Enter; (s) failed-delivery
records have an explicit **retention lifecycle** (scoped per PR/run, audited-closed
on PR closure/supersession, never silently dropped by cleanup) so they neither
block unrelated runs nor erase an unresolved failure; (t) the operator-visible
escalation is **durable/restart-surviving** with **ack-aware dedup** that
re-surfaces a lost emission — so dedup cannot recreate the opk-57/58 invisibility;
(u) a **mid-delivery capability change** (stale marker) is an audited transition
that disables new busy Enters, preserves single-flight, and falls back to
idle+backstop; (v) unresolved-record association uses **durable sequence/monotonic
ordering**, not raw wall-clock, robust to WSL clock skew; (w) the smoke marker must
record **consumed-after-flush** (not enqueue-only) with `no_manual_enter`, and bind
the **tmux version/config** as part of the full input path (drift fails closed);
(x) CI marker validation is **mandatory** (preflight is additional, no "and/or"
escape); (y) closed-PR audited-closure is **inactive-only and reactivates on PR
reopen** unless consumed/re-covered/operator_disposed. Note the load-bearing
assumptions: programmatic `tmux send-keys Enter` must be confirmed equivalent to
manual Enter on a busy worker — so busy-state dispatch ships **fail-closed until a
recorded per-backend smoke marker** exists (manual smoke + the deterministic
dispatch-mechanics contract) — and queue/absorb behavior plus content-identity
strength are backend/AO-surface dependent, hence the verification-driven,
fail-closed-when-unobservable (not assume-once, not per-runtime-capability-branch)
design.

### GPT adversarial pass (discuss-with-gpt)

GPT loop: 10 passes; stopped because cap-10; last-pass accepted=5; final
STATE=completed_valid VALIDATION=ok pass=f76460df-0039-48a7-907e-0c3033ffd91b
sha=63ee9a7e5f867bb55addefc821f211b3404ed79a71d561c07e207c244f1e68ea.
**Post-GPT change not re-reviewed:** the pass-10 findings (consumed-after-flush
marker evidence, tmux/config drift in the marker, PR-reopen reactivation, the
AC16 "and/or"→mandatory-CI fix, and idle-path first-dispatch freshness) were
**accepted and applied after** that final pass, so the GPT loop did not
adversarially re-review them; the normal architect `codex review` covers the
current draft. The loop converged from a premise-overturning rewrite (Enter on a
busy worker enqueues safely → the `isSessionStreaming` refusal, not a budget race,
was the bug) through busy/idle scoping, drain-settle single-flight, the
delivery-anchored backstop, the two-success-terminal state machine, durable
failed-delivery signalling + lifecycle, and the per-backend machine-checkable
smoke gate.

## Verification

- Vitest/Pester fixtures for every acceptance criterion and matrix cell, in the
  existing mechanical node-filter `plan`/`outcome` pattern over synthetic
  AO-status, events, tracking, and review-run inputs (no live tmux).
- Crash-across-re-dispatch fixture; attempt-cap-crash-accounting fixture
  (under/over-count, write-ahead `dispatch-attempted`); two-runner single-flight
  fixture proving no stacked/double Enter on a busy-enqueued delivery;
  ambiguity-no-false-confirm fixture; observability-indeterminate, hung-vs-
  legitimately-busy backstop, and late-consume-after-terminal fixtures; terminal-
  tombstone-no-reclassify fixture; negative-identity and identity-unprovable
  (shape-identical-foreign) fixtures; delivery-anchored zero-dispatch (busy-dispatch
  disabled, never-dispatched) bounded-escalation fixture; failed-delivery-signal
  emission fixture; corrupt active-record / wrong-state-root escalation fixtures
  (carried from #281); idempotent-escalation dedup fixture; `config_invalid` fixture
  for the cap / lease / delivery-anchored-backstop override.
- Deterministic dispatch-mechanics test (non-live): asserts the dispatch resolves
  the correct pane target, sends a single Enter, and places no payload on argv —
  guarding the programmatic path independently of the manual TUI smoke.
- Per-backend smoke-gate guard: a **mandatory CI** check (plus an additional
  startup-preflight guard) that **fails closed** if busy-state dispatch is enabled
  for a backend lacking a valid recorded sanitized smoke marker — covering marker
  schema, staleness (dispatch-signature **or** backend/TUI/runtime drift), and
  default-off (Codex-enabled / unproven-backend-disabled fixtures). CI is not
  substitutable by preflight alone.
- `pwsh -NoProfile -File scripts/worker-message-submit-reconcile.ps1 -Once -DryRun`
  stays green; dry-run writes only to an isolated state root (production journal /
  active records unchanged after it).
- Manual live-smoke (documented, not a CI gate): operator routes one multi-line
  send to a worker that is **busy** (mid-turn) and *observes* the **programmatic**
  arbiter Enter enqueue (the "submitted after next tool call" TUI cue) without
  interrupting, **then that the queued finding is flushed and consumed when the turn
  ends with no manual Enter**. **The recorded marker evidence is bounded flags**
  (`busy_enter_enqueued_observed` **and** `consumed_after_flush_observed` **and**
  `no_manual_enter`) **+ backend/TUI/runtime/tmux versions** — never the captured
  terminal text (sanitized metadata-only per #281). An enqueue-only observation is
  an invalid (incomplete) marker.
- Required pack CI green; no core/vendor/dashboard diff.
