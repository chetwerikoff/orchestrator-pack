# CI-failure ping must suppress on live worker state, re-checked at delivery

GitHub Issue: #342

## Prerequisite

- `docs/issues_drafts/37-ci-failed-ping-before-report-stale-backstop.md` (GitHub #109) —
  **closed/shipped.** Introduced `reactions.ci-failed`: ping the PR-owning worker on red CI
  before the 30-minute `report-stale` backstop. This draft does **not** change *that* the
  ping exists; it changes *when it is suppressed*.
- `docs/issues_drafts/90-ci-failure-notify-cross-path-dedup.md` (GitHub #283) —
  **closed/shipped.** Built the SEND/SUPPRESS predicate (`ci-failure-notification` decide):
  episode-keyed dedup of the ci-failed reaction, plus a `worker_fixing_ci_for_episode`
  suppressor and an intent-token. **This draft extends #283** — it keeps the predicate and
  its dedup/intent-token suppressors, and replaces only the *fixing-worker* suppressor's
  binding (see Goal).
- `docs/issues_drafts/78-review-trigger-reeval-ready-after-early-wake.md` (GitHub #235) —
  **closed/shipped.** Precedent for a state-derived, restart-surviving, decide-then-deliver
  re-check (the same TOCTOU shape this draft closes for the ci-failed ping).
- **Durable submit-ack dependency (#232 / #89).** This draft's crash-safe `claimed → sent`
  requires an **episode-keyed durable submit acknowledgement / idempotent delivery identity**.
  If the shipped worker-message submit arbiter (#232) / delivery-confirmation (#89) already
  expose such a primitive, this draft depends on it **read-only** (and the arbiter stays out of
  scope). If they do **not**, exposing that minimal primitive is a **Prerequisite** to this
  draft — it must **not** be faked in the ci-failed wrapper (that would recreate false-`sent` /
  duplicate-ping). Resolve which case holds before implementation.
- Same binding-fragility class as **#218** (a predicate bound to a head SHA `ao report`
  never emits): here the `worker_fixing_ci_for_episode` suppressor binds to a full episode
  key (`headSha + redPeriod + targetGeneration`) that a plain `ao report fixing_ci` from the
  worker never carries — so the suppressor structurally cannot match.

## Goal

When CI turns red on a PR, suppress the `ci-failed` worker ping whenever there is already a
**live worker for that PR actively fixing CI** (it reported `fixing_ci` and passes a liveness
probe), evaluating that worker state at the single point the ping would actually be
delivered rather than at the moment red CI was first observed. The ci-failed ping must remain
the legitimate kick for a worker that is genuinely idle on red CI; it must stop spamming a
worker that is already fixing. The decision must be correct across the whole worker-state ×
decision-timing matrix below, not only for the one reproduced case.

```behavior-kind
action-producing
```

The success path gates an observable side effect (a worker ping is sent or suppressed), so
this is action-producing and carries a positive-outcome criterion under **Acceptance criteria**.

## Binding surface

What this issue commits the repository to:

- **Reuses (unchanged):** the #283 SEND/SUPPRESS predicate and its terminal-action contract
  (`SEND` | `SUPPRESS`), the episode-keyed reaction-event dedup suppressor, and the
  orchestrator intent-token suppressor. The redacted episode-keyed audit line stays the
  emitted contract for every decision.
- **Trigger is keyed to the canonical #283 episode key — every red head gets its own episode.**
  The `ci-failed` reaction enqueues a pending record keyed to the **full #283 episode key**
  (`repo + prNumber + headSha + redPeriod + targetId + targetGeneration`) — not a reduced key —
  so the reused #283 store, dedup, claims, and acknowledgements all match and distinct
  generations never collapse. A PR head
  that advances while still red enqueues a **new** episode for the new head (it is a distinct
  key, not deduped against the superseded old one) — so abandoning the stale episode
  (`abandoned-superseded`) never leaves the new failing head with no episode.
  A target-generation rotation (worker crash-restart, session reassignment) while the PR head is
  still red also enqueues a **new** episode for the current target (`targetId` +
  `targetGeneration`), terminalizing the old episode as `abandoned-superseded`. This prevents a
  terminal `suppressed-live-worker` on the old generation from stranding the new worker, and
  ensures the fresh episode is subject to the new worker's live state. The re-enqueue may be an
  in-band evaluation decision or a distinct trigger; the contract is that the old episode's
  terminal outcome never blocks a kick for the new worker on the same red CI.
  **Post-terminal rotation (no pending episode):** if the old generation's episode is already
  terminal (e.g. `suppressed-live-worker`) and the PR-owning worker session generation rotates
  while CI stays red on the same head, the reconcile tick must detect the current
  `targetId` + `targetGeneration` has no eligible pending episode for that key and enqueue a
  fresh one — the `ci-failed` reaction does not refire for the same head, so the reconcile
  surface owns this re-enqueue.
- **Dedup / intent-token suppressors exclude the episode's own pending record + claim.** The
  reused #283 reaction-event dedup and intent-token suppressors apply to *other / duplicate*
  enqueue or retry records — **not** to the currently evaluated episode's own pending record or
  its own claim. A first-time pending episode for an idle worker must reach `sent`, never
  self-terminalize as `suppressed-dedup` / `suppressed-intent-token` against itself.
- **Enqueue-only reaction + single live-state evaluation (the decision model).** The
  `ci-failed` reaction does **not** decide SEND at fire time. It only **records** the red-CI
  episode (an episode-keyed pending record). A single reconcile/delivery step then reads live
  worker state as **one coherent snapshot**: if the reader exposes a comparable snapshot/version
  marker, use it; otherwise read the PR head, then the session/lifecycle state, then **re-read
  the PR head** — if it changed across that bracket, treat it as skew and do **not** act
  (non-terminal retry next tick). This makes coherence falsifiable without assuming a shared
  version source, so the evaluation never decides on mixed PR-vs-owner state. It emits the
  **one** terminal action for that episode, decided from this initial eligible snapshot **plus
  the mandatory pre-submit revalidation** in `claimed/preflight` (both pre-intent reads; see the
  outbox state machine below). There is no eager "decided SEND" at fire time that a later re-check
  overturns, and no reclassification once a submit-intent is reserved — **shrinking** the
  decide→deliver TOCTOU window from the reproduced ~60 s gap down to the irreducible
  preflight-read→intent-reserve gap (see the accepted residual below), and removing the
  two-audit-line ambiguity by construction. (Same reconcile-tick shape other orchestrator
  side-processes already use.)
- **Delivery-eligibility boundary (non-blocking) — the evaluation must not run in the enqueue
  tick.** A pending episode becomes eligible for the live-state evaluation only after at least
  one lifecycle-state refresh / reconcile tick has elapsed since enqueue, so a worker that
  reacts to red CI on its own has a chance to transition to `fixing_ci` before the single read.
  Evaluating immediately on enqueue (seeing the worker still idle and sending) would reopen the
  reproduced race and is explicitly disallowed. The boundary is expressed as reconcile-tick /
  state-re-read eligibility, never a blocking sleep; the exact cadence is the planner's, the
  not-same-tick invariant is the contract. **Freshness SLA (measurable upper bound):** a single
  **named, configured** maximum eligible-evaluation age governs how long a pending episode may
  wait before its evaluation under a healthy reconciler. That value must be **at most 3×** the
  reconcile interval **and** strictly less than the `report-stale` window (so the ping keeps
  #109's pre-backstop purpose); the acceptance test measures actual evaluation age against that
  configured value, asserts the configured cap ≤ 3× reconcile interval, and fails if exceeded. The exact number is the operator/planner's config, but
  it is a concrete measurable threshold — not prose. The expiry window is the *degraded* ceiling,
  a separate, larger bound; satisfying expiry while violating this SLA is a failure.
- **Pending→terminal state machine (atomic, idempotent).** The pending record has exactly one
  atomic transition to a terminal action; terminal actions are exactly `sent`,
  `delivery-failed` (the durable submit never acknowledged after bounded retry — escalated, see
  the outbox below), `suppressed-live-worker`, `suppressed-dedup`/`suppressed-intent-token` (the
  pre-existing #283 reasons), `abandoned-no-live-owner`, `abandoned-expired`, and
  `abandoned-superseded` (the episode key's `headSha` no longer matches the PR head, or a
  different live PR-owning session exists with a different `targetGeneration`). The transition is
  idempotent across
  orchestrator restart, worker crash, and reaction retry — no episode produces two pings or
  two conflicting terminal records. **Strict outbox state machine (crash-safe, no stale ping,
  no false-suppress):** the lifecycle is
  `pending → claimed/preflight → submit-intent-reserved → submitted-unacked → sent | delivery-failed/escalated`.
  The conditional claim (compare-and-set keyed by episode + prior state) wins exactly once, so
  concurrent evaluations / wrapper re-entry cannot both act. **Live-state suppression is allowed
  only before a durable submit-intent is reserved** — i.e. in `claimed/preflight`, the evaluation
  (and a recovery retry that is still pre-intent) re-reads live suppressors and may terminalize
  `suppressed-live-worker` / `abandoned-superseded` / `abandoned-no-live-owner` instead of
  sending (this is where the at-delivery goal is enforced — no stale post-claim ping). **Once a
  durable submit-intent (with a message idempotency key) is reserved, the episode is past the
  point of reclassification:** the external send may have crossed the boundary, so recovery
  **resolves that delivery identity** (idempotent re-submit → terminal `sent` on ack, or
  `delivery-failed`/escalated) and must **never** flip to a suppression reason — that would let
  the audit claim `suppressed` while a ping was actually delivered. `sent` is reached only on a
  durable submit acknowledgement (reuse the delivery-confirmation path, #232/#89); a crash in
  `submitted-unacked` is recoverable via the idempotency key and never falsely `sent`. (Suppress outcomes terminalize directly — no in-flight state —
  since they have no external delivery to confirm.) **Accepted residual TOCTOU:** the preflight
  re-read and the submit-intent reservation are not a single atomic step, so in that sub-tick gap
  a worker entering `fixing_ci` **or** the PR head / target-generation identity changing can still
  produce **one** ping to the target reserved at intent time (including a superseded target). This
  is the irreducible floor (not the reproduced ~60 s window); it is bounded to a single ping — the
  #283 dedup / intent-token suppressors prevent any repeat — and is explicitly accepted, not
  claimed away. **Expiry:** the pending record's clock runs from the
  episode-record (enqueue) time; a record that never reaches a live evaluation before expiry
  transitions to terminal `abandoned-expired`. The expiry window must be **no longer than the
  existing `report-stale` backstop window** (so a stuck pending never outlives the backstop
  that would catch the same idle worker); the exact value within that bound is the planner's
  choice. **`abandoned-expired` is a degraded outcome, not a normal suppress:** under a healthy
  reconciler every pending episode is evaluated well before expiry, so reaching it means the
  reconciler was unhealthy. It therefore must (a) be audited as degraded **with an observable
  correlation to the onward backstop surface** (a linkage in the audit + the reconcile-health
  signal below), and (b) be **correlation-only — it emits no new nudge/escalation action of its
  own**; the unchanged `report-stale` backstop remains the single onward action for the idle
  worker, so `abandoned-expired` cannot double-nudge alongside `report-stale`. It must never
  silently swallow a kick a live idle worker still needed, but it also must not duplicate the
  backstop it hands off to.
- **`claimed`/in-flight has its own bounded lifecycle, separate from never-evaluated pending.**
  Expiry of a **never-evaluated pending** record yields `abandoned-expired` (above). A record
  already in `claimed`/in-flight is **not** expired by that same scanner — it follows a bounded
  delivery retry and, if the ack never arrives, **escalates** (degraded, audited) rather than
  being silently terminalized. Expiry and a late successful delivery can never both terminalize
  the same episode: the conditional claim that moved it to `claimed` already excludes the expiry
  scanner from terminalizing it, so there is exactly one terminal outcome.
- **Runtime non-terminal failures are operator-visible, not just "loud."** Beyond the startup
  gate, a non-terminal hard failure that occurs *after* startup (later YAML/reader drift,
  malformed capture, wrapper parse failure) must surface as a distinct **reconcile-health /
  Status** degraded state carrying pending episode age + count — so an operator can tell
  "temporarily re-evaluable" from "this reaction is broken and accumulating pending records."
  Reuse the existing supervisor/Status health surface (the #248/#60 "report real health"
  contract), not a new one.
- **One pending store, reused — not a new one.** The pending→terminal record reuses #283's
  existing durable episode-keyed intent-token / terminal store and the existing supervised
  reconcile surface; this draft does **not** introduce a parallel pending store, lock, or
  reconciler. If reuse proves insufficient, naming the concrete store/reconcile owner is in
  scope (see Files in scope), but a separate lifecycle is not the default.
- **Deterministic terminal-reason precedence when predicates overlap.** Exactly one terminal
  reason wins, in this order: (1) an already-terminal record for the episode is immutable
  (idempotency — never re-decided); (2) missing/incompatible input is a non-terminal hard
  failure and blocks terminalization (it never co-emits with a terminal reason); then among a
  fresh decision: (3) `abandoned-superseded` (checked **before** any worker-state suppressor:
  the episode key's `headSha` no longer matches the PR head, or a **different live**
  PR-owning worker session exists whose `targetId` + `targetGeneration` differs from the
  episode's — since an obsolete episode must never be sent or suppressed against a stale target;
  if the PR is still red but a new live owner has rotated in, the evaluation terminalizes the
  old episode as `abandoned-superseded` and enqueues a fresh pending episode keyed to the
  current `targetId` + `targetGeneration`; if no live owner exists, this rule does **not**
  apply — fall through to `abandoned-no-live-owner`); (4)
  `suppressed-intent-token`; (5)
  `suppressed-dedup`; (6) `suppressed-live-worker` (`fixing_ci`); (7) `abandoned-no-live-owner`;
  (8) `sent`. `abandoned-expired` is orthogonal — it is the terminal for a record that was
  **never evaluated** before expiry, so it cannot co-occur with a fresh decision. The same
  episode resolves to the same reason on every retry path.
- **Suppressing state is `fixing_ci` only.** Suppress when the live PR-owning worker is in
  `fixing_ci` — the unambiguous signal the worker itself reports when fixing CI. `working` is
  **not** a suppressing state (bare `working` is ambiguous and would need a fuzzy
  "recent-on-this-PR" sub-rule that is both hard to make observable and risks over-suppression
  / over-specification); `pr_created` is **not** a suppressing state (a worker that opened a
  PR may be idle awaiting handoff — suppressing there recreates the "idle PR waits for the
  30-min backstop" outcome the ping exists to prevent). The reproduced case is covered:
  the worker had reported `fixing_ci`.
- **The live worker must pass a positive liveness probe.** A suppressing state only counts if
  the PR-owning session passes a positive liveness check — not merely a record with a
  refreshing timestamp (AO is known to leave dead sessions in non-terminal `cleanup` with a
  moving timestamp). A liveness-failing record is treated as no live owner.
- **Deterministic PR→worker resolution.** Define how PR ownership resolves when there are
  multiple sessions, a restarted worker, a worker on an old head SHA, or a reassigned PR — so
  suppression never keys off a stale/wrong/dead owner. Resolution and liveness are part of the
  contract, not the planner's guess.
- **No-live-worker terminal outcome is CHOSEN here (not deferred to Verification):** when no
  live worker owns the PR, the worker-ping resolves to **SUPPRESS** with audit reason
  `abandoned-no-live-owner` — there is no live target to kick. The orphaned-PR case is left to
  the existing backstop/escalation surface (unchanged, out of scope); this path must not emit
  a phantom ping and must not silently drop the signal (the suppression is audited).
- **Accepted input shape is pinned to a golden capture, not a hand-invented schema.** The
  fields this path consumes (PR ownership, liveness, worker state, head SHA) are accepted in
  exactly the shape the **real AO session/lifecycle reader emits**, captured as a golden
  snapshot (defer to the field-shape guard, draft #76). The startup gate, the incompatible-shape
  failure, and the fixtures all validate against that captured shape — so they cannot pass
  against a locally invented schema that has drifted from AO. This avoids the architect
  enumerating field paths/types (planner/AO owns the reader shape) while still binding the
  contract to reality (the #218 lesson).
- **The golden capture must be sanitized / allowlisted.** A real lifecycle/session capture can
  carry session ids, local absolute paths, command lines, env-derived values, or `.ao`-adjacent
  operational state. The committed fixture must include **only the fields this predicate
  consumes**, with an explicit redaction check for secrets, session tokens, absolute paths, env
  values, and `.ao` payloads — "no credential/session leakage," stronger than "no new repo
  secrets," and consistent with the `.ao/**` denylist.
- **Runtime diagnostics are allowlisted too — not just committed fixtures.** The loud diagnostic
  / health / audit emitted on a malformed / truncated / wrong-encoding **live** payload (or a
  live-YAML self-check failure) must use **allowlisted field names + error codes only**, never
  raw payload, YAML, env, path, or `.ao` fragments. A failure-path diagnostic is a
  credential/session-leakage surface, not just test hygiene.
- **Fail loud on incompatible OR absent shape.** If the live wiring does not feed that input,
  **or** feeds an incompatible shape (renamed/missing/re-nested fields from a future AO reader
  change), the path emits a loud diagnostic and does **not** silently revert to the pre-#283
  unconditional ping. Missing/incompatible input is a **non-terminal hard failure**
  (re-evaluable next tick, surfaced loudly) — **not** one of the terminal actions above, and it
  must not burn the episode. Pair with the reaction-init gate (see Operator adoption +
  Verification).
- **Audit phase markers.** Every emitted audit line carries a phase marker
  (`phase=record` for the pending enqueue, `phase=terminal` for the one terminal action); only
  the `phase=terminal` line is authoritative for terminal-action consumers, so a pending
  record can never be misread as the outcome.
- **Required-input validation is a reaction-scoped init gate, not only a per-episode runtime
  failure.** The self-check that the live wiring feeds the required worker-state input runs at
  `ao start` / reaction load and fails loud there, disabling **only** `reactions.ci-failed`
  (surfacing degraded health) — **not** the whole orchestrator: a bad ci-failed wiring merge
  must not take down unrelated AO duties. A drifted live YAML therefore disables this one
  reaction loudly instead of backlogging non-terminal pending episodes. The per-episode
  non-terminal hard failure is the runtime backstop beneath that gate, not the primary guard.
- **PR→worker ownership reuses the existing live-PR-owner resolution.** Ownership resolves via
  the same authoritative PR→live-worker mapping the shipped PR-owning-worker reconcilers use
  (#191), with liveness and head/branch as the tie-breaker (a live session on the PR's current
  head wins over a stale or old-head one); this draft does not invent a new ownership
  source-of-truth.
- **Episode key must still match the PR at evaluation (no stale-episode ping).** The pending
  record is keyed to the **red-CI head** (`headSha`) and the **notification target**
  (`targetId` + `targetGeneration`). If the PR head has advanced past the episode's head, or a
  different live PR-owning worker session has rotated in with a new generation, the episode is **stale** — it no longer
  describes the current PR/target — and terminalizes as **`abandoned-superseded`** (audited),
  not a ping about an obsolete failure; a fresh red CI on the new head or a fresh target
  generation produces its own episode. The evaluation decides against the **episode** key, never a
  newer head's or generation's worker.
- **Worker-state input transport must be robust, not just present.** Whatever mechanism feeds
  the worker-state JSON to the predicate must carry a realistic lifecycle/session capture
  **without truncation**, and a malformed / truncated / wrong-encoding payload maps to the
  non-terminal hard failure (not a silent unconditional ping, not a crash). The exact transport
  (stdin / file / argument) is the planner's choice; the robustness + failure-mapping is the
  contract. (Direct lesson from the 64 KiB pipe-truncation class that motivated this work.)
- **Out of bounds (explicitly not changed):** the ping for a genuinely idle worker still
  fires; the `report-stale` (~30 min) backstop is untouched; a worker that reported
  `ready_for_review` on red CI is **not** treated as "fixing" and is therefore not suppressed
  by this path (that mis-report is a different reaction's concern).
- **No blocking sleep.** Any grace/debounce between first decision and delivery must be
  expressed as reconcile-tick / state-re-read, never an in-reaction blocking wait that holds
  a turn or a lock.

### Operator adoption

This touches the orchestrator reaction wiring (the `ci-failure-notification` decide block in
`agent-orchestrator.yaml`), so after the PR merges the operator must:

1. Merge the changed `ci-failed` reaction block from `agent-orchestrator.yaml.example` into
   the live (gitignored) `agent-orchestrator.yaml`, ensuring the decide step is fed the
   worker-session/lifecycle state it now needs.
2. `ao stop` then `ao start` so the new reaction wiring loads.
3. Run the machine-checkable self-check that reads the **actual live (gitignored)
   `agent-orchestrator.yaml`** — not the example — and returns pass/fail on whether the
   `ci-failed` block feeds the predicate the required worker-state input **and** whether the
   episode-keyed durable submit-ack primitive (#232/#89) is present. `reactions.ci-failed` is
   considered enabled only when **both** pass; if either is absent it is disabled (degraded
   health), never silently reverting to the unconditional ping. (CI validates the example YAML;
   only this operator command can prove the live config + ack capability after the merge/restart.)
4. Verify: force or observe a red-CI episode on a PR whose worker is actively fixing, and
   confirm the audit line records a suppression (not a send) for that episode.

## Files in scope

- The CI-failure notification decide helper and its PowerShell wrapper (the predicate that
  returns `SEND` / `SUPPRESS`).
- Its test/fixture surface.
- The `ci-failed` reaction block in `agent-orchestrator.yaml.example` (and the matching
  documentation of what JSON the decide step is fed).
- A startup / reaction-init self-check (or extension of an existing diagnose/verify surface)
  that, when the live reaction wiring does not provide the required worker-state input, leaves
  `ao start` / the orchestrator **running** but **disables only `reactions.ci-failed`** (loud +
  degraded health) — it never fails the whole orchestrator and never backlogs pending episodes.
- The pending→terminal record reuses #283's existing durable episode-keyed intent-token /
  terminal store and the existing supervised reconcile surface (reused, not rebuilt); only if
  reuse is proven insufficient does naming a concrete new store/reconcile owner enter scope.
- At least one golden capture from the real AO session/lifecycle reader, used as the fixture
  input shape (defer to the golden-sample field-shape guard, draft #76, where in force).
- The architect declaration snapshot for this issue.

## Files out of scope

- The `report-stale` reaction and its 30-minute backstop.
- The CI-green wake path (#191) and review-trigger / review-send reconcilers.
- The worker-message submit arbiter (#232) and its state file.
- Any change to what the worker runs for `ao report fixing_ci` (the fix must not require the
  worker to emit a synthetic episode key).

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
```

```allowed-roots
scripts/**
docs/**
agent-orchestrator.yaml.example
```

## Acceptance criteria

- The fixing-worker suppressor fires from the **live PR-owning worker's state**, not from an
  episode-key match in a worker report. A plain `ao report fixing_ci` (carrying no synthetic
  episode key) from the live worker for the PR results in `SUPPRESS`, not `SEND`.
- PR→worker ownership resolves deterministically: multiple sessions, a restarted worker, a
  worker on an old head SHA, and a reassigned PR each resolve to a defined owner-or-none, and
  a session that fails the positive liveness probe (e.g. a `cleanup` zombie with a refreshing
  timestamp) is **not** treated as an active owner.
- When the PR-owning worker's session generation rotates, the reconcile surface ensures a fresh
  episode for the current target: if a pending episode exists, the old one terminalizes as
  `abandoned-superseded`; if the old generation's episode is already terminal
  (`suppressed-live-worker`), reconcile enqueues a new episode for the current generation — so the
  old terminal outcome never blocks a kick for a newly-idle new worker.
- `fixing_ci` is the only suppressing worker state; `working` and `pr_created` do **not**
  suppress (justified against the "idle worker still gets the kick" criterion).
- The reaction only records the episode; the terminal action is decided from an initial eligible
  snapshot **plus a mandatory pre-submit (pre-intent) revalidation** — both reads (and the
  recovery-path re-read) may determine a suppression, and once a submit-intent is reserved there
  is no reclassification. There is no eager SEND at fire time that a later read overturns. A
  worker that entered `fixing_ci` after red CI was observed but before the (pre-intent) read is
  suppressed (the reproduced ~60 s gap).
- The pending record makes exactly one atomic, idempotent transition to a terminal action
  across orchestrator restart, worker crash, and reaction retry — no episode produces two
  pings or two conflicting terminal records; a pending record past its expiry resolves to its
  defined terminal/abandoned outcome.
- Every audit line carries `phase=record`, `phase=diagnostic`, or `phase=terminal`; only
  `phase=terminal` is authoritative for terminal-action consumers. Non-terminal hard failures
  emit `phase=diagnostic` (re-evaluable, episode not burned).
- When no live worker owns the PR, the worker-ping resolves to **SUPPRESS** with audit reason
  `abandoned-no-live-owner` (no phantom ping, signal not silently dropped); the orphaned-PR
  case is left to the unchanged backstop/escalation surface.
- A genuinely idle live worker on red CI (passes liveness, not in a suppressing state, no
  other suppressor matched) still receives the ping — the kick is preserved.
- If the required worker-state input is **absent or an incompatible shape** (renamed/missing/
  re-nested fields), the path emits a loud diagnostic, treats it as a **non-terminal hard
  failure** (re-evaluable next tick, episode not burned), and does **not** silently revert to
  the unconditional ping. Missing/incompatible input is not one of the terminal actions.
- Every terminal action emits the existing redacted episode-keyed audit line with a stable
  reason string, distinguishing `sent`, `delivery-failed`, `suppressed-live-worker`,
  `abandoned-no-live-owner`, `abandoned-expired`, `abandoned-superseded`, and the pre-existing
  dedup / intent-token reasons. Reason strings are exact and stable for downstream consumers.
  Map each to the reused `SEND | SUPPRESS` contract: `sent`/`delivery-failed` are the SEND-path
  outcomes (delivered vs. escalated-after-retry); the rest are SUPPRESS-path outcomes.
- The full scenario matrix below is covered by fixtures, one equivalence class per cell, on
  **capture-backed** worker-state input sourced from the real AO session/lifecycle reader
  (not a hand-shaped schema) — closed siblings (#283, #109) show no regression.

```positive-outcome
asserts: a red-CI episode for a PR whose live worker is in fixing_ci yields SUPPRESS (suppressed-live-worker), and a red-CI episode for an idle PR-owning worker (or one in working/pr_created) yields SEND
input: external-tool-output
provenance: capture-backed
```

### Scenario matrix (fix the class, not the case)

Each row is an explicit **event sequence** — state when red CI is observed → transition(s)
before the eligible evaluation → state **at evaluation** → expected terminal action — so a
fixture is a real sequence, not a hand-waved cell. The outcome is always decided by the single
live-state read at evaluation; the sequences prove the read sees **current** state (the
reproduced gap and "already fixing" both resolve correctly).

| # | State at red-CI observed | Transition before eligible evaluation | State at evaluation | Terminal action |
|---|---|---|---|---|
| 1 | idle | worker self-starts → `fixing_ci` (the reproduced ~60 s gap) | `fixing_ci`, live | **`suppressed-live-worker`** |
| 2 | `fixing_ci` | none | `fixing_ci`, live | **`suppressed-live-worker`** |
| 3 | idle | none | idle, live | **`sent`** (legitimate kick) |
| 4 | idle | → `working` (not on this PR's CI) | `working`, live | **`sent`** (working not suppressing) |
| 5 | idle | → `pr_created` | `pr_created`, live | **`sent`** (pr_created not suppressing) |
| 6 | `fixing_ci` | → `ready_for_review` on still-red CI | `ready_for_review` | **`sent`** (not this path's suppress; mis-report owned elsewhere) |
| 7 | `fixing_ci` | session dies (now a `cleanup` zombie w/ refreshing ts) | fails liveness probe | treated as no live owner → **`abandoned-no-live-owner`** |
| 8 | (any) | no session owns the PR | no live owner | **`abandoned-no-live-owner`** (audited; no phantom ping) |
| 9 | (any) | multiple / restarted / old-head sessions | resolve to one owner-or-none (per #191 + liveness/head tie-break), then apply its row | per resolved owner |
| 10 | (any) | evaluated **in the enqueue tick** (too early) | not eligible | **disallowed** — must wait the eligibility boundary, then re-evaluate (proves row 1) |
| 11 | (any) | worker-state input absent / incompatible shape | — | **non-terminal hard failure** (loud, re-evaluable; not a terminal action; no unconditional ping) |
| 12 | idle | reconciler unhealthy past expiry | never evaluated | **`abandoned-expired`** (degraded, audited, observable backstop/escalation handoff) |
| 13 | (any) | PR head advances past the episode's red-CI head before evaluation | episode head ≠ PR head | **`abandoned-superseded`** (no ping about an obsolete failure; new head gets its own episode) |
| 14 | (any) | worker session restarts (target generation rotates) before evaluation | old episode's targetGeneration ≠ current owner | _old episode:_ **`abandoned-superseded`** (fresh episode enqueued for current generation, evaluated per its own row) |
| 15 | idle | claim/preflight, crash **before** submit-intent reserved; worker now `fixing_ci` | recovered pre-intent | **`suppressed-live-worker`** (revalidation allowed pre-intent — no stale ping) |
| 16 | idle→`fixing_ci` | submit-intent reserved, crash in `submitted-unacked` (ping may have crossed) | recovered post-intent | **resolve delivery identity** (idempotent re-submit → `sent` on ack, else `delivery-failed`/escalated) — **never** reclassified to suppression |

Reproduced case (rows 1 + 2): `ci-failed` fired ~60 s before the worker entered
`working`/`fixing_ci`, and the repeat pings fired while the worker was actively fixing — the
old episode-key binding left both open; the single eligible live-state evaluation closes them.

## Upgrade-safety check

- No edits to AO core, `vendor/**`, or `packages/core/**`.
- No new repository secrets.
- Only supported `agent-orchestrator.yaml` reaction/command shapes; no `reviewer:` block.
- **Denylist feasibility.** The reused #283 store, the supervised reconcile surface, and the
  Status/health surface live in the editable `scripts/**` + `docs/**` surface (not behind
  `packages/core/**` / `vendor/**` / `.ao/**`), so the CAS claim, pending lifecycle,
  reaction-scoped gate, and degraded-health changes are implementable without a denied edit. If
  any required primitive turns out to need an otherwise-denied path (AO core), that is an
  explicit escape condition to surface for re-scoping — **not** something to approximate in
  YAML/wrappers at the cost of the safety properties.
- The worker's reporting contract is unchanged — the fix lives entirely in the orchestrator
  predicate + reaction wiring + the single reconcile/delivery evaluation.
- **Backward compatibility with shipped #283 state/audit.** Because #283 is already merged,
  records and audit lines written before this change may lack `phase`, the pending-state
  fields, and the new terminal reasons. Define how a legacy record/audit line is interpreted
  after upgrade: an already-terminal legacy record stays terminal (never re-terminalized), a
  legacy audit line without a `phase` marker is treated as authoritative-terminal (so the
  "only `phase=terminal` is authoritative" rule does not hide legacy outcomes), and an
  in-flight legacy episode is migrated to the new pending shape without producing a duplicate
  ping. Ship a no-duplicate migration/regression fixture covering an in-flight and a
  terminalized legacy episode.

## Verification

- **Fixture group A — worker-state × timing outcomes:** one fixture per state/timing cell of
  the matrix, sourced from a **golden capture of the real AO session/lifecycle reader** (not a
  hand-shaped schema), asserting the terminal action + audit reason — including the B1 cell
  (worker enters `fixing_ci` after red CI is observed but before the evaluation → SUPPRESS) and
  the `working`/`pr_created`-do-not-suppress cells.
- **Fixture group B — PR→worker resolution:** multiple sessions, restarted worker, old-head
  worker, reassigned PR, and a liveness-failing `cleanup` zombie each resolve as specified (the
  zombie is not a suppressor). State explicitly which group-A × group-B combinations are
  mandatory end-to-end (not the full cross-product) so the suite neither explodes nor fakes
  one-fixture-per-row.
- Concurrency / atomic-claim test: two reconcile/delivery evaluations (or a wrapper re-entry)
  racing on the same pending episode result in exactly one ping and one terminal record — the
  conditional-claim invariant holds.
- Crash-after-claim-before-ack test: a crash between the `claimed`/in-flight write and the
  durable submit acknowledgement leaves the episode recoverable (delivery retried, idempotent)
  and **never** falsely terminal `sent` with no ping delivered.
- Too-early-evaluation test: an evaluation attempted in the enqueue tick does not act; the
  episode is evaluated only after the eligibility boundary (proves the reproduced row 1).
- Schema-conformance test: the predicate consumes exactly the field paths present in the golden
  capture; a renamed/missing/re-nested field is the non-terminal hard failure (not a silent
  ping).
- Capture-redaction check: the committed golden fixture contains only the consumed fields and
  passes a redaction check (no secrets, session tokens, absolute paths, env values, `.ao`
  payloads).
- Head-drift fixture: the PR head advances between enqueue and eligible evaluation → the stale
  episode terminalizes superseded/abandoned (no ping), not decided against the newer head.
- Snapshot-skew fixture: PR metadata and session/lifecycle reads at version mismatch → the
  evaluation does not act (non-terminal retry), not a mixed-state decision.
- Claimed-expiry race test: an in-flight `claimed` record past the pending expiry window is not
  terminalized by the expiry scanner; its bounded retry/escalation owns the outcome, and a late
  ack and expiry never both terminalize.
- Live-YAML adoption check: the operator command reads the actual gitignored
  `agent-orchestrator.yaml` (not the example) and returns machine-checkable pass/fail gating
  whether `reactions.ci-failed` is enabled.
- Dependency check: confirm whether #232/#89 already expose the episode-keyed durable
  submit-ack primitive; if not, the prerequisite is unmet and this draft blocks on it (no
  wrapper-faked ack).
- Idempotency test: a worker crash / orchestrator restart / reaction retry between the
  recorded pending episode and the terminal evaluation produces exactly one terminal record
  and at most one ping (no duplicate ping, no ping-after-suppress).
- Expiry / no-silent-strand test: a pending episode for a live **idle** worker that reaches
  expiry terminalizes to `abandoned-expired` and asserts **both** the audit correlation to the
  backstop **and** the degraded reconcile-health signal, **and** that no new nudge/escalation
  action is emitted (`report-stale` remains the sole onward action) — not "either/or."
- Legacy-upgrade fixture: a pre-change #283 record/audit line (no `phase`, old reasons), both
  in-flight and terminalized, is interpreted per the compatibility rule with no duplicate ping
  and no re-terminalization.
- Incompatible-shape test: a renamed/missing/re-nested worker-state field is a non-terminal
  hard failure (loud diagnostic, no unconditional ping), distinct from absent input.
- A regression fixture proving a plain `ao report fixing_ci` (no episode key) for the live PR
  worker now suppresses where #283's episode-key binding would have sent.
- The `abandoned-no-live-owner` SUPPRESS outcome and its audit reason are asserted explicitly.
- A test/self-check proving that with the worker-state input absent the predicate fails loud
  (diagnostic + audit reason) rather than reverting to unconditional SEND, and that the
  startup / reaction-init gate, when the live wiring omits the required input, leaves `ao start`
  **succeeding** (orchestrator running, exit pinned separately) while **only** `reactions.ci-failed`
  is disabled + degraded — asserting both the orchestrator-up and reaction-disabled states, so
  the test cannot be satisfied by taking down unrelated AO duties or by an endless pending backlog.
- Precedence test: overlapping matches (e.g. dedup + live `fixing_ci`, intent-token +
  no-live-owner, incompatible-input + already-terminal record) resolve to the single defined
  winning reason, identically across retry paths.
- Health-visibility test: a post-startup non-terminal hard failure surfaces as a degraded
  reconcile-health / Status state carrying pending episode age + count (distinguishable from a
  transient single-tick re-evaluation).
- Real-path test: the actual `agent-orchestrator.yaml` reaction → wrapper command path (not
  just the helper in isolation), fed the capture-backed input, runs on the pack's actual
  operating runtime — **pwsh 7 on Linux/WSL2** (the orchestrator's environment) and the CI
  ubuntu runner — to catch cross-shell quoting / path / newline / payload-size drift (the
  64 KiB-pipe class). If Windows PowerShell is also a supported operator environment it is
  included; otherwise the draft declares this path Linux/WSL-only.
- Expiry-handoff no-duplicate test: `abandoned-expired` emits no nudge of its own; the idle
  worker is covered by `report-stale` alone, with no double operator noise / double nudge.
- Self-dedup test: a first-time pending episode for an idle PR worker terminalizes `sent`, not
  `suppressed-dedup`/`suppressed-intent-token` against its own record/claim.
- Revalidate-before-submit test (**pre-intent only**): an episode in `claimed/preflight` (before
  any submit-intent is reserved) whose worker enters `fixing_ci` terminalizes
  `suppressed-live-worker` — no stale ping. (The post-intent crash case is the separate
  resolve-delivery test below; post-intent never reclassifies to suppression.)
- Red-to-red head-advance test: the old episode terminalizes `abandoned-superseded` **and** a
  fresh pending episode exists for the new still-red head (no gap in coverage).
- Target-generation-rotation test (pre-terminal): a pending episode whose `targetGeneration`
  diverges from the current PR-owning session terminalizes as `abandoned-superseded` and is
  replaced by a fresh episode for the current generation.
- Post-terminal-generation-rotation test: an episode already terminal
  `suppressed-live-worker` on the old generation, then a session restart while CI stays red on
  the same head, enqueues a fresh pending episode for the new generation (reconcile-owned, not a
  `ci-failed` refire).
- Freshness-SLA test: under a healthy reconciler an eligible idle episode's evaluation age is
  measured against the configured max-eligible-evaluation-age and fails if exceeded (and the
  config is asserted < the `report-stale` window) — not merely under the expiry ceiling.
- Delivery-failed test: a durable submit that never acknowledges after the bounded retry
  terminalizes `delivery-failed` (escalated, audited), not a phantom `sent`.
- Snapshot-coherence test: a PR head change across the bracketing reads (or a marker mismatch)
  yields non-terminal retry, not a mixed-state decision.
- Crash-after-submit-intent test: a crash in `submitted-unacked` (ping may have crossed the
  boundary) followed by the worker entering `fixing_ci` resolves the delivery identity (re-submit
  → `sent` on ack, else `delivery-failed`/escalated) and is **never** reclassified to
  `suppressed-live-worker` — no audit claiming suppression when a ping was delivered.
- Runtime-diagnostic redaction test: a malformed/truncated live payload and a live-YAML
  self-check failure emit only allowlisted field names + error codes — no raw payload / YAML /
  env / path / `.ao` fragments (a failure fixture asserts no secrets/session ids/absolute paths).
- Read-source test: for normal and recovered-pre-intent paths, the audit reason records which
  read decided it (initial eligible snapshot vs pre-submit revalidation). For
  `submitted-unacked` recovery, the audit records a delivery-resolution source (ack vs bounded
  retry exhaustion) — no worker-state read decides that outcome.
- Re-run the #283 and #109 fixtures to show no regression in the dedup / intent-token /
  backstop-ordering behavior.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome
  -DraftPath docs/issues_drafts/110-ci-failure-ping-suppress-on-live-worker-state.md` passes.

## Decisions (design analysis)

**Prior art.** #109 (draft 37) shipped the `ci-failed` ping (kick a worker that would
otherwise sit idle on red CI before the 30-min stale backstop). #283 (draft 90) shipped the
SEND/SUPPRESS predicate that dedups the ping and suppresses it when (a) a ci-failed reaction
event already bound to the episode, (b) a `fixing_ci` report binds to the **full episode
key**, or (c) an intent token owns the ping. Suppressor (b) is the gap: the full episode key
(`headSha + redPeriod + targetGeneration`) is the orchestrator's synthetic construct; a plain
`ao report fixing_ci` from the worker never carries it, so (b) structurally cannot match —
the same class as #218 (predicate bound to a field the real tool never emits). The chosen
scope keeps (a) and (c) intact and re-binds (b) to observable live worker state; it does not
re-implement the predicate.

**Critical mechanics.** (1) The signal that a worker is "already fixing" must be one the
worker actually produces — live session/lifecycle/activity state, not a synthetic key. (2)
The decision is not a point event: there is a decide→deliver window (~60 s observed) in which
the worker can transition from idle to fixing, so a single decide-time evaluation is wrong by
construction. (3) The "kick the idle worker" purpose must survive — over-suppression would
strand a genuinely idle worker on red CI until the 30-min backstop.

**Industry practice.** Notification/alert pipelines suppress on **current resource state**
(is someone already on it?) evaluated at fire time, not on a stale decision; debounce windows
re-check state at the end of the window rather than blindly emitting. Binding to an
authoritative live-state read (here: AO session state) over a self-reported synthetic token
is the standard reliability move.

**Options (cheapest sufficient with acceptable risk; tests + Codex review the safety net):**

1. **Re-bind suppressor (b) to live PR-worker `fixing_ci` state, evaluated once at delivery
   via an enqueue-only reaction (CHOSEN).** The reaction records the red-CI episode; a single
   reconcile/delivery evaluation reads live worker state once and emits the one terminal
   action — no intermediate SEND to overturn. Reuses the AO session/lifecycle state signal
   other reconcilers already consume and #283's other suppressors. Cheapest sufficient: a
   predicate-input + reconcile-step change to one shipped helper, reusing a proven signal and
   the repo's existing reconcile-tick shape; risk bounded by the matrix fixtures and the
   preserved #283/#109 regressions. (The enqueue-only single-evaluation form was adopted from
   GPT pass 2 — it removes the decide→deliver TOCTOU window and the two-audit-line ambiguity
   that a "decide-SEND-then-re-check" form would carry.)
2. **Make `ao report fixing_ci` carry the full episode key so (b) matches (REJECTED).**
   Requires the worker (and possibly upstream AO) to compute the orchestrator's synthetic
   episode key — the worker cannot know `redPeriod` / `targetGeneration`. High cost, fragile,
   pushes orchestrator state into the worker contract.
3. **Blocking grace delay before send (REJECTED).** The originally-suggested fixed delay does
   not fix binding (b) — after the wait the re-check still can't recognize a fixing worker —
   and the observed gap (~60 s) makes any safe fixed value either too short or a turn-/lock-
   holding blocking sleep in the reaction path. A non-blocking tick-based debounce is at most
   an optional complement to option 1, never the fix.

Recommended: **option 1.** Option 5-class enumeration (the scenario matrix) is mandatory here
because the cause is a decision / event-ordering path and this extends a shipped fix that
closed only one cell.

**Decomposition decision (considered, rejected).** A split into "re-bind suppressor first,
delivery re-check as a follow-up" was weighed (GPT's alternative). Rejected: re-binding
without the delivery re-check leaves the **reproduced** TOCTOU cell open (the ~60 s gap where
the ping is decided before the worker starts), so the first slice would not be independently
sufficient — it would ship a fix that still spams in the exact observed case. The re-bind,
the delivery re-check, and the single atomic terminal record are one coherent contract and
stay one draft.

### GPT adversarial pass log

Pass 1 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 6 findings):

- *Live PR-worker identity underspecified* — **accepted.** Added deterministic PR→worker
  resolution + positive liveness probe (zombie `cleanup` records excluded) to Binding surface,
  acceptance, matrix.
- *No-live-worker outcome unchosen* — **accepted.** Chose `SUPPRESS` / `abandoned-no-live-owner`
  in the draft itself; removed the "state in Verification" deferral.
- *Delivery re-check lacks persisted idempotency* — **accepted.** Bound decide+deliver to one
  atomic episode-keyed terminal record (extends #283's intent token); added idempotency test.
- *Suppressing state set too broad / matrix inconsistent* — **accepted.** Enumerated states:
  `fixing_ci` always, `working` only on-PR, `pr_created` excluded; fixed the matrix.
- *Capture source unspecified* — **accepted.** Required a golden capture from the real AO
  session/lifecycle reader (defer to draft #76); fixtures use that shape.
- *Live-YAML drift, weak verification* — **accepted.** Added fail-loud-on-missing-input (no
  silent SEND revert) + startup/self-check to Operator adoption and Verification.

Pass 2 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 6 new findings; ledger
held, no relitigation):

- *Missing-input has no legal terminal action* — **accepted.** Classified missing/incompatible
  input as a non-terminal hard failure, explicitly outside the terminal enum.
- *Delivery re-check has no pending lifecycle* — **accepted.** Adopted the enqueue-only model:
  reaction records a pending episode, one reconcile evaluation makes the single atomic
  pending→terminal transition, with a defined expiry.
- *Decide/delivery audit lines confusable* — **accepted.** Added `phase=record|terminal`
  markers; only `phase=terminal` is authoritative.
- *Runtime input schema weaker than fixtures* — **accepted.** Added a minimal accepted input
  schema; fail loud on incompatible shape, not only absent.
- *`working` evidence undefined* — **accepted by narrowing.** Dropped `working` (and kept
  `pr_created` out); suppress only on the unambiguous `fixing_ci`.
- *`GitHub Issue: TBD`* — **rejected.** `TBD` before sync is the normal create-issue-draft
  flow; the publish step binds the number.
- *Enqueue-only alternative* — **adopted** as the chosen architecture (see option 1).

Pass 3 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 6 findings; ledger held):

- *Positive-outcome block contradicts `fixing_ci`-only* — **accepted.** Corrected the block to
  `fixing_ci`→SUPPRESS, working/pr_created→SEND.
- *Expiry required but unspecified* — **accepted.** Specified: clock from enqueue, window ≤
  `report-stale` backstop, terminal `abandoned-expired` (exact value the planner's).
- *Files in scope omit persistence/reconciler surface* — **accepted (adopted P3 alternative).**
  Reuse #283's durable intent-token/terminal store + existing supervised reconcile surface; no
  parallel store; added to Binding surface + Files in scope.
- *Terminal-reason precedence undefined on overlap* — **accepted.** Defined a deterministic
  7-step precedence; same episode → same reason on every retry.
- *Self-check manual / infinite-retry risk* — **accepted.** Made the required-input check a
  startup / reaction-init gate that blocks the path, with the per-episode failure as backstop.
- *Cross-shell path under-validated* — **accepted (trimmed).** Added a real YAML→wrapper-path
  verification item on the pack's supported runtime(s).

Pass 4 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 4 findings; ledger held):

- *Atomic-claim owner unnamed* — **accepted.** Added the compare-and-set invariant
  (terminalization = single conditional write keyed by episode + prior state; deliver only
  after the claim) + a concurrency test.
- *Post-startup stuck queue invisible* — **accepted.** Required runtime non-terminal failures
  to surface as a degraded reconcile-health/Status state with pending age + count (reuse #248/#60).
- *`abandoned-expired` may silently swallow a kick* — **accepted.** Defined it as a degraded,
  audited handoff to backstop/escalation (only under reconciler unhealth) + a no-silent-strand
  test.
- *Matrix fixture explosion* — **accepted.** Split fixtures into group A (state×timing) and
  group B (PR-owner resolution), with named mandatory cross-products.

Pass 5 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 5 findings; ledger held):

- *Legacy #283 records/audit on upgrade* — **accepted.** Added a backward-compatibility rule
  (legacy terminal stays terminal; pre-`phase` audit lines authoritative; in-flight migrated
  with no duplicate ping) + a migration regression fixture in Upgrade-safety.
- *Wrapper JSON transport underspecified* — **accepted (trimmed).** Required transport
  robustness (no truncation of a realistic capture; malformed/truncated → non-terminal hard
  failure) without prescribing stdin/argv/tempfile — directly ties to the originating 64 KiB
  pipe-truncation class.
- *Startup gate too broad* — **accepted.** Scoped the gate to disable only `reactions.ci-failed`
  + degraded health, never the whole orchestrator.
- *Ownership tie-breaker* — **accepted (reuse).** Tied resolution to the shipped #191 live-PR-
  owner mapping with liveness/head as tie-breaker; no new source-of-truth.
- *Backstop handoff not observable* — **accepted.** `abandoned-expired` must carry an
  observable correlation/escalation event; the no-strand test asserts it.

GPT twice suggested narrowing scope (defer operability/health to a follow-up). Considered and
declined: the CAS atomic claim, legacy compatibility, and missing-input operability are
inseparable from a *safe, upgrade-correct* version of the core change — a narrower PR would
ship an unsafe or upgrade-breaking suppressor. Kept as one contract.

Pass 6 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 6 findings; ledger held):

- *Claim-before-deliver false `sent` on crash* — **accepted.** Replaced straight-to-`sent` with
  claim→`claimed`/in-flight→deliver→`sent` on durable submit ack (reuse #232/#89); crash in
  in-flight is recoverable, never false `sent`.
- *Delivery timing unconstrained* — **accepted.** Added the non-blocking eligibility boundary
  (not evaluated in the enqueue tick; ≥1 lifecycle refresh) + too-early test.
- *Schema not pinned* — **accepted.** Pinned the accepted shape to the golden capture (real AO
  reader shape authoritative; defer #76) rather than hand-enumerated fields.
- *Capture may leak session data* — **accepted.** Required a sanitized/allowlisted capture +
  redaction check (stronger than "no new secrets").
- *Denylist feasibility* — **accepted.** Noted the reused surfaces are editable (`scripts`/`docs`);
  escape condition if a primitive needs a denied path.
- *Matrix conflates timing with eval-state* — **accepted.** Restructured the matrix into 12
  explicit event sequences.

Pass 7 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 5 findings; ledger held):

- *Durable submit-ack vs out-of-scope arbiter* — **accepted.** Added a Prerequisite: depend
  read-only on an episode-keyed durable submit-ack from #232/#89 if it exists, else expose it as
  a prerequisite — never fake ack in the wrapper.
- *PR head-drift between enqueue and evaluation* — **accepted.** Stale episode (PR head advanced)
  terminalizes `abandoned-superseded`; decide against the episode head; matrix row 13.
- *Gate must read live gitignored YAML* — **accepted.** Operator self-check reads the actual
  live YAML (not example), machine-checkable, gates reaction-enabled.
- *"Single read" needs a coherent snapshot* — **accepted.** Defined as one coherent snapshot;
  version skew → non-terminal retry.
- *`claimed` not in expiry/precedence* — **accepted.** `claimed`/in-flight has a bounded
  retry/escalation lifecycle separate from never-evaluated pending; expiry can't terminalize a
  claimed record.

Pass 8 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 5 findings; ledger held;
all consistency/integration tightening of passes 6–7 additions — no new behavioral classes):

- *Precedence omits new terminal reasons* — **accepted.** Inserted `abandoned-superseded`
  (before suppressors); noted `abandoned-expired` is the orthogonal never-evaluated terminal.
- *Init gate doesn't cover the ack prerequisite* — **accepted.** Gate now validates both
  worker-state input and the #232/#89 durable submit-ack; disabled if either absent.
- *`abandoned-superseded` naming inconsistent* — **accepted.** Standardized the exact string
  everywhere + added to the audit-reason acceptance criterion.
- *Expiry handoff could double-cover report-stale* — **accepted.** Made `abandoned-expired`
  correlation-only (no new nudge); `report-stale` is the sole onward action + no-duplicate test.
- *Runtime coverage vague* — **accepted.** Named the runtime explicitly (pwsh 7 Linux/WSL2 + CI
  ubuntu; Windows PowerShell only if a supported operator env).

Pass 9 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 5 findings; ledger held):

- *Episode self-triggers #283 dedup/intent* — **accepted.** Scoped dedup/intent to exclude the
  episode's own pending record + claim; first-time idle → `sent` fixture.
- *Claimed retry sends stale ping after worker starts fixing* — **accepted (adopted ALT).**
  Revalidate live suppressors before each unacked submit; claimed → `suppressed-live-worker` if
  now fixing — decision not frozen at claim.
- *New-head red episode assumed* — **accepted.** Trigger keyed (PR, headSha, redPeriod); a
  still-red head advance enqueues a fresh episode; red-to-red fixture.
- *Idle ping can drift to ~report-stale* — **accepted.** Added a freshness SLA (bounded ticks,
  well ahead of backstop) distinct from the degraded expiry ceiling.
- *"Coherent snapshot" not falsifiable* — **accepted.** Concretized as a PR-head re-read bracket
  (or marker), skew → non-terminal retry.

Pass 10 (`STATE=completed_valid VALIDATION=ok`, verdict NEEDS_ATTENTION, 3 findings; ledger held;
**the 10-pass cap**):

- *Unacked submit reclassified as suppression* + *single-read vs revalidation contradiction* —
  **accepted (adopted strict-outbox ALT).** Replaced the loose "revalidate-before-submit" with a
  strict outbox: `pending → claimed/preflight → submit-intent-reserved → submitted-unacked → sent
  | delivery-failed/escalated`. Live-state suppression is allowed **only pre-intent**; once a
  durable submit-intent (idempotency key) exists, recovery resolves the delivery identity and
  never flips to a suppression reason. (rows 14–15)
- *Runtime diagnostics not redacted* — **accepted.** Extended the allowlist/redaction contract to
  live diagnostics/health/audit on malformed input + live-YAML failure (codes/fields only, never
  raw payload/YAML/env/path/`.ao`).

**Post-cap confirmatory review (open risk resolved).** The pass-10 revisions (strict outbox +
runtime-diagnostic redaction) were not GPT-re-reviewed (11th pass exceeds the cap), so the
normal architect **Codex** draft review served as the confirmatory adversarial pass. Codex
found 3 valid issues, all in that post-cap area — (P1) the revalidate-before-submit test wording
contradicted the outbox (post-intent suppression); (P1) `delivery-failed` was missing from the
terminal-action + audit-reason contract; (P2) the freshness SLA was not falsifiable. All three
were applied (pre-intent-only test wording; `delivery-failed` added to the enum, audit list, and
a test, mapped to the SEND path; freshness SLA bound to a named configured measurable threshold).
The open risk is closed.

Architect Codex draft review ran to convergence (4 iterations): iter 1 — 2×P1/1×P2 (post-cap
outbox contradiction, missing `delivery-failed`, non-falsifiable SLA); iter 2 — 1×P1/2×P2
(residual preflight→intent TOCTOU, one-read vs revalidation conflict, add `allowed-roots`); iter
3 — 1×P1/2×P2 (episode key dropped `targetGeneration`, expiry either/both, `ao start` result
ambiguous); **iter 4 — clean (no findings).** All applied: bounded-accepted residual TOCTOU,
`delivery-failed` in the terminal+audit contract, configured measurable freshness SLA, canonical
#283 episode key, both-not-either expiry observability, and `ao start`-stays-up / reaction-only
disable. Sync gate satisfied.

`GPT loop: 10 passes; stopped because cap-10; last-pass accepted=3; final STATE=completed_valid VALIDATION=ok pass=0ce618a9-6bc3-4a99-be50-b9497e1119a6 sha=a82e65f7b71bb5fc31f5f422e8687a32ba095f56e06c378b63ac2e00af2f6cfb (post-pass-10 revisions not re-reviewed by GPT — see Open risk above).`
