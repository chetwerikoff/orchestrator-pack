# Event-driven first review must trigger on the `ready_for_review` hand-off, not only on the `merge.ready` completion wake
GitHub Issue: #381

## Prerequisite

Already-merged work this draft builds on (reused, not re-implemented):

- `docs/issues_drafts/70-orchestrator-event-driven-review-trigger.md` (GitHub
  #207, closed) — the event-driven first-review trigger. **Already does:** drives
  the first `ao review run` from the orchestrator wake listener on a supervised
  surface, with readiness = #195 verbatim and covered-head dedupe via run state.
  **Gap this draft closes:** #207 rides the **`merge.ready`** completion wake
  (approved-and-green) only; the listener never starts a review from a
  `ready_for_review` hand-off notification, so the *first* review (which happens
  before any approval) has no event to ride.
- `docs/issues_drafts/78-review-trigger-reeval-ready-after-early-wake.md` (GitHub
  #235, closed) — re-evaluates a head an early wake deferred as not-yet-ready.
  **Already does:** the 5s reeval fast-polls heads **already seeded** by a prior
  wake-defer until they become ready. **Gap:** seeding depends on a wake that is
  admitted; an `info`-priority hand-off is dropped, so a fresh head is never
  seeded and falls to the slow backstop.
- `docs/issues_drafts/58-safe-review-trigger-reconciliation.md` (GitHub #163,
  closed) — the periodic reconcile. **Already does:** sweeps open PRs every 10
  min and starts a ready head on its own tick. **Role here:** stays the backstop,
  unchanged; this draft removes the dependence on it for the *first* review.
- `docs/issues_drafts/67-orchestrator-review-gate-on-handoff.md` (GitHub #195,
  closed) — the readiness gate. **Already does:** start only after hand-off
  (`ready_for_review` for the exact head + CI contract; CI red defers). **Reused
  verbatim** as the admit-then-evaluate predicate.
- `docs/issues_drafts/88-review-start-atomic-claim.md` (GitHub #267) and
  `docs/issues_drafts/100-review-start-claim-atomic-single-winner.md` (GitHub
  #308) — the single-winner per-`(PR, head)` review-start claim. **Already does:**
  every automated starter passes the same atomic claim; at most one winner.
  **Reused:** the new admit path starts through this same claim, so duplicate or
  repeated notifications cannot double-start.
- `docs/issues_drafts/106-review-and-cinudge-per-cycle-settle-gate.md` (GitHub
  #332, closed) — the per-worker-iteration cycle gate. **Already does:** arms
  review-start once per cycle (`already_reviewed_this_cycle`). **Reused:** the new
  path is subordinate to this gate; it never re-arms within a settled cycle.
- `docs/issues_drafts/74-review-head-ready-report-sha-independent-binding.md`
  (GitHub #218, closed) — SHA-less latest `ready_for_review` is eligible on green
  CI. **Reused:** the admitted notification resolves to head coverage via
  observable state, not a report-stored SHA.
- `docs/issues_drafts/113-review-trigger-stale-binding-must-not-block-fresh-ready-head.md`
  (GitHub #352, **open — must merge first**) — the shared wake-relevance/ready
  classifier that all reconcile/event/reeval starters use (stale older SHA-less
  report must not block a fresh current-head hand-off). **Sequencing (resolves the
  GPT-flagged required-but-out-of-scope contradiction):** this draft **consumes**
  #352's shared classifier to satisfy its stale-vs-fresh acceptance (AC5); it must
  not re-implement or fork that classifier on the listener path. If #352 is not
  yet merged when this is scheduled, this draft is **blocked** on it — it does not
  ship a divergent listener-only classifier.

Queued / open work this draft must not overlap (cross-referenced, not folded):

- `docs/issues_drafts/112-review-loop-worker-fresh-green-fast-reengage.md` (GitHub
  #348, open) — fast re-engagement for a worker idling on a fresh green head it
  **never re-reported**. **Distinct axis:** #348 covers the *absent* re-report
  (no hand-off signal exists); **this draft** covers the *present-but-discarded*
  hand-off (the signal exists as an `info` notification and is dropped). They meet
  at the same claim/cycle gate but seed from opposite preconditions.

## Goal

A worker's `ready_for_review` hand-off must be able to start the first review run
within seconds of being reported, whether AO delivers that hand-off notification
at `info` or `action` transport priority. Today the orchestrator wake listener's
event-driven trigger acts only on the `merge.ready` completion wake, and its wake
filter discards `info`-priority notifications wholesale — so a real hand-off
delivered at `info` priority never reaches the trigger, and the first review
starts only when the 10-minute reconcile backstop next sweeps the PR.

```behavior-kind
action-producing
```

## Binding surface

What the repository commits to (contracts; implementation left to the planner):

- **Hand-off semantic is the trigger key, not transport priority.** The
  event-driven review-start path must treat a notification whose payload carries
  the `ready_for_review` hand-off semantic for an in-project session + open PR as
  a candidate first-review signal, regardless of the notification's `priority`
  (`info` or `action`). A hand-off delivered at `info` priority must not be
  discarded before the readiness decision is reached.
- **Full event-envelope match, not a bare semantic string.** Admission must match
  the complete hand-off envelope AO emits — notification family/type
  (`type: notification`, `event.type: session.working`), the `ready_for_review`
  semantic, and the PR/session subject shape — not only the `semanticType` field.
  An unrelated notification that merely carries the string `ready_for_review` in
  that field must not be promoted out of the `info` drop.
- **Admit, then evaluate — never start blindly.** Admitting the hand-off only
  *reaches the decision*; the start itself stays gated by the existing #195
  readiness predicate (hand-off for the exact current head + CI contract; CI red
  or pending defers, not starts) and resolves head coverage via #218 observable
  state. An admitted hand-off on a red/pending head defers (and is eligible for
  the existing reeval watch), it does not start.
- **One start per `(PR, head)`.** The admitted path starts review only through the
  existing single-winner atomic claim (#267/#308) and is subordinate to the
  per-cycle gate (#332). Duplicate notifications, an `info`+`action` pair for the
  same event, or repeated re-reports within a settled cycle must result in at most
  one review run for the head.
- **Scope the admit narrowly.** Only the `ready_for_review` hand-off semantic is
  promoted out of the `info`-priority drop. Other `info` notifications (status,
  progress, non-hand-off events) stay dropped; this draft does not widen the
  filter to admit `info` traffic generally.
- **Identity-bound admission (closes the cross-project safety gap).** A promoted
  hand-off is admitted only when its notification resolves to the **supervised
  listener's own project and repository** (repository derived from the supervised
  project mapping / subject PR url), an **in-project session**, and an **open PR**
  for the head — verified before any review-start logic runs. A notification
  carrying `ready_for_review` with a foreign `projectId`/`sessionId`, a
  non-matching repository, or no open PR is rejected at the filter, not at the
  start path.
- **Start-time revalidation (TOCTOU guard).** Filter-time open-PR + identity
  checks bound admission, but the shared classifier / start decision must re-run
  the **full #195/#352 readiness predicate immediately before acquiring the
  claim** — open-PR + head-current **and** the CI contract + exact-head hand-off
  state. A PR closed/merged, a head whose CI flipped green→red/pending, **or a PR
  retargeted (its base ref changed from the admitted base ref)** between admission
  and claim must not start a review. *"Retargeted" is defined concretely as a
  change in the PR base ref*; the pre-claim check compares the current base ref to
  the base ref captured at admission and defers on mismatch. Reuses the existing
  pre-run re-check pattern (#189/#207), not a new mechanism.
- **Transient admission-lookup failure is retryable, not a reject.** Identity /
  repository / open-PR resolution that needs an external lookup (gh/API/cache) and
  fails transiently (timeout, rate-limit, stale cache, temporary error) yields a
  retryable **unknown** outcome — audited distinctly and retained for re-evaluation
  — never a permanent filter reject and never a silent drop of the event path
  (read-error = unknown, per the #235 transient-failure pattern).
- **Orphaned-claim reclaim.** A crash after the claim is won but before a durable
  run record / reviewer process exists must not tombstone the head: a claim held
  with no live run is reclaimable (reclaim / replay / audited release), so
  reconcile and reeval are not permanently blocked by an `already held` claim with
  no review behind it. Reuses the orphan-run reap intent of #98 and crash-safe
  terminal status of #287.
- **Idempotent, crash-safe deferred seeding.** A reeval watch entry seeded on a
  red/pending hand-off must be keyed by project/repo/PR/head and be idempotent
  across duplicate `info`/`action` delivery and listener restart — duplicate
  notifications or a crash after admission must not create duplicate or unbounded
  watch records, and a later start re-classifies the head through #352 before
  acting. (Round-trip/size safety follows the committed reconcile-state envelope
  established by #339.)
- **Green-head crash → bounded recovery, not backstop.** A hand-off admitted on a
  green head but interrupted by a listener crash/restart before the review start is
  durably recorded must be **recovered within ≤ 30 seconds of the listener becoming
  ready** — the durable admission/seed is replayed so the head re-enters the
  event/reeval path, **not** left to the 10-minute reconcile. The 10-minute
  reconcile remains the last-resort net **only** when the durable record itself is
  lost, and that fallback is audited. This narrows — and does not contradict — AC1:
  AC1's ≤30s bound is the crash-free path; the restart path's guarantee is ≤30s
  post-restart recovery when the record exists, not the 10-minute backstop.
- **Observable promotion/rejection audit.** Every outcome of the new path emits a
  structured, greppable audit record: hand-off **promoted** out of the `info`
  drop, **rejected** at the filter (identity/envelope/no-PR), readiness **defer**
  + reeval **seed**, start-time **TOCTOU reject**, and claim **win/loss** — so
  starvation or false admission is distinguishable from listener silence (the
  exact diagnosis friction this draft's own incident hit).
- **Shared classifier preserved.** The relevance/ready classification used here is
  the same one shared across reconcile, event, and reeval starters (#352); the
  stale-older-report-must-not-block-fresh-head ordering and #218 supersession
  remain intact. No second divergent classifier on the listener path.
- **Backstop unchanged.** The 10-minute reconcile (#163) remains the fallback for
  any head that produced no admissible event; this draft reduces reliance on it
  for the first review but does not remove or reconfigure it.

## Files in scope

- `scripts/` — the orchestrator wake listener and its wake-filter / review-wake
  trigger library, the shared review-trigger classifier, and their tests.
- `tests/external-output-references/` — capture-backed fixtures and manifest
  entries needed to prove the hand-off-at-`info` behavior (entries already
  present; add fixtures only if a scenario lacks one). **Policy note (resolves the
  AGENTS.md Allowed-Edits scope question):** this is the **canonical capture home**
  the #366 `capture@…` contract-evidence system resolves against, and worker PRs
  for #223 and #352 already committed fixtures here — so capture work for this task
  is authorized at this tree, not relocated.
- `AGENTS.md` — **required in-scope change (not a follow-up):** extend the
  Allowed-Edits list to name the reference-capture tree
  (`tests/external-output-references/**`) so this task's capture commits are
  compliant under active repository rules. `AGENTS.md` is already an allowed-edit
  root, so the worker authors this in the same PR.
- `docs/architecture.md` — **required** review-paths decision-log entry recording
  the trigger-key change (hand-off semantic admission vs transport-priority /
  completion-wake filtering), so the durable contract is not only in this draft
  and a future reviewer does not reintroduce priority-based dropping of hand-offs.

## Files out of scope

- `agent-orchestrator.yaml.example`, `orchestratorRules`, reactions — no operator
  contract change; the listener already runs under the supervisor.
- `plugins/**`, `packages/core/**`, `vendor/**`, AO core, `.ao/**`.
- The 10-minute reconcile interval and the `merge.ready`/approval path — untouched.

```denylist
vendor/**
packages/core/**
.ao/**
```

## Acceptance criteria

1. A `ready_for_review` hand-off notification delivered at `priority: info` for an
   open PR whose current head is hand-off-ready on green CI causes the first
   review run to be started through the single-winner claim within a **concrete,
   falsifiable bound: ≤ 30 seconds** measured from the listener's receipt of the
   notification (audited receipt timestamp) to the review run's `createdAt` — well
   inside the 10-minute reconcile / 15-minute heartbeat cadence. The test must
   **fail** if the start lands only on the reconcile/heartbeat backstop, so it
   distinguishes true event-driven start from merely faster polling. (This bound is
   the **crash-free path**; the listener-restart window is governed by AC13.)

   ```positive-outcome
   asserts: an info-priority ready_for_review notification on a green hand-off head starts exactly one first review run via the atomic claim within 30s of listener receipt, failing if it only starts on the reconcile/heartbeat backstop
   input: external-tool-output
   provenance: capture-backed
   ```

2. The same hand-off semantic delivered at `priority: action` reaches the same
   admit-then-evaluate path and produces the identical start decision (parity
   between the two captured priority variants).

   ```positive-outcome
   asserts: action-priority and info-priority ready_for_review for the same head reach the same start decision
   input: external-tool-output
   provenance: capture-backed
   ```

3. An admitted `ready_for_review` hand-off on a head whose CI is red or pending
   **defers** (no start) **and observably seeds the same reeval watch state that
   #235 consumes** — proven by inspecting the persisted reeval watch entry for the
   head, not merely by asserting "no start." The entry is keyed by
   project/repo/PR/head and is **idempotent** across duplicate `info`/`action`
   delivery and listener restart (no duplicate or stale records); a later start
   re-classifies through #352. When CI later turns green, the already-seeded head
   starts on the seconds-scale reeval, not on the reconcile backstop.

4. Duplicate delivery — an `info` + `action` pair for one event, or repeated
   `info` re-reports — yields **exactly one** review run for the `(PR, head)`. The
   loser is suppressed observably by **either** an already-held single-winner claim
   **or** the #332 per-cycle gate (whichever fires first for the arrival order);
   the spec does not mandate which gate catches it, only that exactly one run
   results.

5. A stale older / SHA-less `ready_for_review` notification that does not match the
   current head does not start a review, and does not block a coexisting fresh
   current-head hand-off — classified by the **same shared classifier #352
   establishes** (consumed, not re-implemented here).

6. A non-`ready_for_review` `info` notification (status/progress) is still dropped;
   the filter is not widened to admit `info` traffic generally.

7. Within a settled review cycle (#332), an additional hand-off notification does
   not re-arm a second start; the per-cycle gate suppresses it.

8. **Identity-bound admission:** a `ready_for_review` notification whose
   `projectId`/`sessionId` is not the supervised listener's own project/in-project
   session, whose repository (resolved from the subject PR url `$.event.data.subject.pr.url`)
   does not match the supervised repo, or which has no open PR for the head, is
   rejected at the filter and never reaches review-start logic. The
   foreign-repository case asserts rejection against that concrete PR-url selector.

9. **Mixed-order, no claim poisoning:** an `info` hand-off that defers on a pending
   head, followed by a later `action` hand-off (or reeval) after CI turns green,
   starts exactly one review — the deferral does not consume the `(PR, head)`
   claim or mark the head handled, so the later green observation still starts.

10. **Full-envelope rejection:** a notification that carries `ready_for_review` in
    `semanticType` but does not match the full hand-off envelope (wrong `type` /
    `event.type` / missing PR subject) is not promoted out of the `info` drop.

11. **`merge.ready` regression:** the existing #207 completion-wake path
    (`merge.ready`, approved-and-green) still reaches the same readiness / claim /
    cycle gates after this change — proven by a legacy `merge.ready` fixture.

12. **Start-time TOCTOU (full predicate):** a hand-off admitted at filter time
    whose PR is closed/merged, whose **base ref changed** from the admitted base
    (retargeted), **or whose CI flipped green→red/pending** before the start
    decision does not start a review; the pre-claim re-check re-runs the full
    #195/#352 readiness predicate (open + head-current + base-ref-unchanged + CI +
    exact-head hand-off), not just PR openness.

13. **Green-head crash recovery (bounded, falsifiable):** when the durable
    admission/seed record **exists** after a listener restart, the head is replayed
    and the review run starts **within ≤ 30 seconds of the listener becoming ready**
    (measured from the listener-ready audit timestamp to the run `createdAt`) — it
    is **not** left to the 10-minute reconcile. The audited 10-minute-reconcile
    fallback is permitted **only** when the durable record itself was lost (never
    for a retained record); the test fails if a retained record starts only on the
    backstop.

14. **Audit contract:** each new-path outcome (promote, filter-reject, readiness
    defer + reeval seed, TOCTOU reject, claim win/loss) emits a structured,
    greppable audit record distinguishable from listener silence.

    ```positive-outcome
    asserts: an admitted info hand-off that starts a review emits a structured "promoted" + "claim win" audit record
    input: external-tool-output
    provenance: capture-backed
    ```

15. **Durable trigger-key record:** `docs/architecture.md` carries a review-paths
    decision-log entry stating the trigger key is the hand-off semantic envelope
    (not transport priority); the entry's presence is checkable in the PR diff.

16. **Transient lookup = retryable unknown:** a hand-off whose identity/open-PR
    resolution fails transiently (API timeout/rate-limit/stale cache) is retained
    as a retryable `unknown` and audited as such — not converted to a permanent
    filter reject and not dropped — and a later successful lookup can still start.

17. **Orphaned-claim reclaim:** a crash after claim win but before a durable run
    record / reviewer process exists leaves a reclaimable claim — reconcile/reeval
    can recover the head (reclaim/replay/audited release), not block forever on an
    `already held` claim with no review behind it.

18. **Capture-tree authorized in the same PR:** `AGENTS.md` Allowed-Edits names the
    reference-capture tree (`tests/external-output-references/**`), so the new
    capture fixtures are committed under active repository rules — no out-of-policy
    write and no deferred authorization.

## Upgrade-safety check

- No AO core, vendor, or `packages/core` edits; the listener consumes AO's
  emitted notification shape, it does not change AO.
- No new operator config, env var, or YAML contract; no new repo secret.
- No new review-start path that bypasses the #267/#308 claim or the #332 cycle gate.
- Captures backing **positive-start** criteria are real AO payloads under the
  committed manifest; no hand-shaped notification fixture satisfies a positive
  criterion. **Negative/rejection** criteria (AC8/AC10/AC12) may use capture-backed
  mutations with explicit `mutated-from` provenance — they prove rejection, never
  a start.
- Committed AO webhook captures carry no secrets/credentials (scrub before commit).

## Verification

- Unit/fixture tests over the captured notifications
  (`ao-webhook-notification/ready_for_review` and
  `ao-webhook-notification/ready_for_review.action-priority`) proving AC1–AC2: the
  hand-off semantic at either priority reaches the start decision and starts once
  within the seconds-scale event-path bound, with a negative assertion that a
  backstop-only start fails the criterion.
- A diff check that `AGENTS.md` Allowed-Edits names
  `tests/external-output-references/**`, proving AC18 the capture commits are
  policy-compliant in the same PR.
- A red/pending-CI fixture proving AC3 defers **and** that the reeval watch state
  consumed by #235 is observably seeded for the head (inspect the persisted entry).
- A duplicate-delivery test (info+action pair; repeated info) proving AC4 single
  start via the claim.
- A stale/SHA-less coexistence fixture proving AC5 against the #352 shared
  classifier (reuse/extend #352 fixtures; no listener-local classifier).
- A non-hand-off `info` notification proving AC6 stays dropped.
- A settled-cycle test proving AC7 suppression.
- A foreign-project / foreign-session / foreign-repository / no-open-PR
  notification proving AC8 rejection at the filter. Negative cases use
  **capture-backed mutations** (a committed real capture with one identity field
  altered, recorded with explicit `mutated-from` provenance) — admissible for
  rejection tests; the no-hand-shaped-fixture rule binds positive-start criteria.
- A mixed-order test (info defers on pending CI → action/reeval after green starts)
  proving AC9: the deferral does not consume the claim.
- An envelope-mismatch fixture (`ready_for_review` string in a non-hand-off
  notification shape) proving AC10 stays dropped.
- A legacy `merge.ready` completion-wake fixture proving AC11 the #207 path is
  unbroken.
- Three AC12 TOCTOU fixtures, one per required branch: (a) PR closed/merged
  between admit and start, (b) base ref changed (retargeted), and (c) CI flipped
  green→red/pending between admit and start — each proving the pre-claim re-check
  rejects, so an implementation cannot omit any one branch and still pass.
- A listener-restart-after-green-admit fixture proving AC13: with the durable
  record present, the run starts ≤ 30s after listener-ready (not on the backstop);
  a separate record-lost fixture proves the audited-backstop fallback is reached
  only when the record is gone.
- An audit-record assertion proving AC14 each outcome emits a greppable structured
  line.
- A `docs/architecture.md` review-paths entry present in the PR diff proving AC15.
- A transient-lookup-failure fixture proving AC16: the event is retained as
  retryable `unknown` and audited, not permanently rejected.
- A crash-after-claim-before-run fixture proving AC17: the orphaned claim is
  reclaimable, not a permanent tombstone.
- The existing PR scope guard (`scripts/pr-scope-check.ps1`) passes the diff
  against the denylist / out-of-scope surfaces (no `vendor/**`, `packages/core/**`,
  `.ao/**`, or AO-core edits) — upgrade-safety enforced mechanically, not by prose.
- The draft-discipline checks pass (run each separately, quoted to stay
  cross-shell-safe — `|` is a shell pipe if unquoted):

  ```bash
  pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command 'positive-outcome' -DraftPath docs/issues_drafts/120-event-driven-review-trigger-on-ready-for-review-handoff.md
  pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command 'parked-root' -DraftPath docs/issues_drafts/120-event-driven-review-trigger-on-ready-for-review-handoff.md
  pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command 'contract-evidence' -DraftPath docs/issues_drafts/120-event-driven-review-trigger-on-ready-for-review-handoff.md
  ```

## Contract evidence

```contract-evidence
binding-id: ao:notification:ready_for_review.semanticType
binding-type: structured
binding: AO emits a ready_for_review hand-off as a session.working notification carrying the ready_for_review semantic
producer: ao
evidence: capture@ao-webhook-notification/ready_for_review
selector: $.event.data.semanticType
expected: ready_for_review
```

```contract-evidence
binding-id: ao:notification:envelope.type
binding-type: structured
binding: the hand-off arrives in a notification-family envelope (full-envelope match, not bare semanticType)
producer: ao
evidence: capture@ao-webhook-notification/ready_for_review
selector: $.type
expected: notification
```

```contract-evidence
binding-id: ao:notification:envelope.event.type
binding-type: structured
binding: the hand-off envelope's event type is session.working
producer: ao
evidence: capture@ao-webhook-notification/ready_for_review
selector: $.event.type
expected: session.working
```

```contract-evidence
binding-id: ao:notification:ready_for_review.priority.info
binding-type: structured
binding: AO can deliver the ready_for_review hand-off notification at info transport priority
producer: ao
evidence: capture@ao-webhook-notification/ready_for_review
selector: $.event.priority
expected: info
```

```contract-evidence
binding-id: ao:notification:ready_for_review.priority.action
binding-type: structured
binding: AO can deliver the same ready_for_review hand-off notification at action transport priority
producer: ao
evidence: capture@ao-webhook-notification/ready_for_review.action-priority
selector: $.event.priority
expected: action
```

```contract-evidence
binding-id: ao:notification:ready_for_review.pr.number
binding-type: structured
binding: the hand-off notification carries the subject PR number used to resolve head coverage
producer: ao
evidence: capture@ao-webhook-notification/ready_for_review
selector: $.event.data.subject.pr.number
expected: 234
```

```contract-evidence
binding-id: ao:notification:ready_for_review.pr.url
binding-type: structured
binding: the hand-off notification carries the subject PR url used to resolve repository identity for admission
producer: ao
evidence: capture@ao-webhook-notification/ready_for_review
selector: $.event.data.subject.pr.url
expected: https://github.com/chetwerikoff/orchestrator-pack/pull/234
```

```contract-evidence
binding-id: ao:notification:ready_for_review.projectId
binding-type: structured
binding: the hand-off notification carries the producing project id used for identity-bound admission
producer: ao
evidence: capture@ao-webhook-notification/ready_for_review
selector: $.event.projectId
expected: orchestrator-pack
```

```contract-evidence
binding-id: ao:notification:ready_for_review.sessionId
binding-type: structured
binding: the hand-off notification carries the in-project session id used for identity-bound admission
producer: ao
evidence: capture@ao-webhook-notification/ready_for_review
selector: $.event.data.subject.session.id
expected: opk-27
```

## Prior-art recon (recorded)

- **Shipped:** #207 event trigger (rides `merge.ready` only), #235 reeval (needs a
  seeded wake), #163 reconcile backstop (10 min), #195 readiness gate, #218
  SHA-less ready eligibility, #267/#308 single-winner claim, #332 per-cycle gate.
- **Queued/open:** #348 (absent re-report — distinct precondition), #352 (shared
  stale-vs-fresh classifier — must be preserved).
- **Scope verdict:** NEW. None of the shipped/queued items wires a
  `ready_for_review` hand-off notification to the first-review trigger; #207 stops
  at `merge.ready`, and the `info`-priority drop severs the only other path. This
  draft fills that gap and extends the #207/#235 trigger family.

## Decision log

- **Root cause (recurrence of #207/#235):** the event-driven first-review trigger
  binds to the `merge.ready` completion wake, and the wake filter drops
  `info`-priority notifications; AO delivers the `ready_for_review` hand-off at
  `info` priority (live listener log `dropped: info_priority`, capture
  `ready_for_review.raw.json`), so the hand-off never reaches a trigger. Same
  binding-bug class as #218 (predicate keyed on the wrong/transport attribute of
  real producer output). Fix at the spec level: key the trigger on the hand-off
  semantic, route through existing claim + readiness + cycle gates.
- **Rejected alternative — lower the reconcile interval (10m→1–2m):** cheap and
  config-only, but it makes the *backstop* faster rather than restoring the
  event path; it never reaches seconds and leaves the structural starvation. Kept
  as an optional operator mitigation, not the durable fix.
- **Rejected alternative — dedicated 15–30s readiness poll over open PRs:**
  achieves seconds without trusting the notification, but adds a new polling
  surface and overlaps #348's re-engagement scope; more cost, no advantage over
  using the signal AO already emits.
- **Chosen:** admit the `ready_for_review` semantic at any priority, evaluate
  through #195, start through #267/#308 + #332. Cheapest sufficient: reuses every
  existing safety net; the only new behavior is not discarding a real signal.

### GPT adversarial pass — accepted findings (pass 1)

- **#352 required-but-out-of-scope contradiction (high) → accepted:** moved #352
  from "must not overlap" to **Prerequisite (must merge first)**; this draft
  *consumes* its shared classifier (AC5) and is blocked on it, never forking a
  listener-local classifier.
- **Admit predicate ungrounded (medium) → accepted:** added identity-bound
  admission (project/session/repo/open-PR) to **Binding surface**, **AC8**, and
  `projectId`/`sessionId` contract-evidence rows.
- **Defer may not seed reeval (medium) → accepted:** **AC3** now requires
  observable seeding of the #235 reeval watch state, not just "no start."
- **Parity masks ordering (medium) → accepted:** added **AC9** mixed-order
  (info-defers-then-action/reeval-after-green) with explicit no-claim-poisoning.
- **Architecture record optional (low) → accepted:** `docs/architecture.md`
  decision-log entry made **required** for the trigger-key change.

### GPT adversarial pass — accepted findings (pass 2)

- **Negative-fixture/repo gap (high) → accepted:** added capture-backed-mutation
  policy for rejection tests, repository binding (project mapping / PR url), and a
  foreign-repository case in AC8 + Verification + upgrade-safety.
- **Bare-semantic admission (high) → accepted:** added full-envelope match to
  **Binding surface**, **AC10**, and `$.type`/`$.event.type` contract-evidence.
- **Seeding not idempotent/crash-safe (medium) → accepted:** **AC3** + a binding
  line now require keyed, idempotent, restart-safe watch entries (#339 envelope).
- **No `merge.ready` regression gate (medium) → accepted:** **AC11** + legacy
  fixture proving the #207 completion-wake path is unbroken.
- **Open-PR check filter-time only (medium) → accepted:** added start-time TOCTOU
  re-check before claim (**AC12** + Binding surface), reusing #189/#207 pre-run
  re-check.

### GPT adversarial pass — considered, not bound (pass 2)

- **`ReviewWakeCandidate` typed adapter (ALTERNATIVE_APPROACH):** a reasonable
  *implementation* structuring, but prescribing it would narrow planner freedom
  (internal layout). The envelope/identity/idempotency requirements above pin
  *what must be true*; the planner picks the shape.

### GPT adversarial pass — accepted findings (pass 3)

- **Repo identity not contract-backed (high) → accepted:** added
  `subject.pr.url` contract-evidence row and AC8 now asserts foreign-repo
  rejection against that concrete selector.
- **Green-head crash path (medium) → accepted:** added green-head crash-recovery
  binding + **AC13** (recover-or-audited-backstop, silent loss forbidden).
- **No audit contract (medium) → accepted:** added observable promotion/rejection
  audit binding + **AC14** (structured greppable records per outcome).
- **Architecture entry not gated (low) → partial:** added **AC15** making the
  `docs/architecture.md` entry an observable PR-diff criterion (no new CI check
  invented — that would prescribe tooling).
- **Shell-fragile verify command (low) → accepted:** split the `-Command` check
  into three separately-quoted invocations (the unquoted `|` was a real bug).
- **Durable `review_wake_candidate` record (ALTERNATIVE) → not bound:** AC13/AC14
  capture the crash-replay + audit *requirements*; the single-record shape is one
  way to satisfy them — left to the planner.

### GPT adversarial pass — accepted findings (pass 4)

- **TOCTOU omits CI revalidation (high) → accepted:** pre-claim re-check now
  re-runs the **full** #195/#352 readiness predicate incl. CI flip green→red
  (**AC12** + Binding surface), not just PR open/current.
- **Transient lookup misclassified as reject (medium) → accepted:** added
  retryable `unknown` admission outcome (**AC16** + Binding surface), per #235
  read-error=unknown; never a permanent reject/silent drop.
- **Orphaned-claim window (high) → accepted:** added orphaned-claim reclaim
  (**AC17** + Binding surface) so a crash after claim-win before run record does
  not tombstone the head (reuses #98 reap / #287 crash-safe terminal).
- **Denylist not diff-verified (medium) → accepted:** Verification now runs the
  existing `scripts/pr-scope-check.ps1` against the diff (reused tooling, no new
  check invented).
- **Durable pre-lookup wake-intent queue (ALTERNATIVE) → not bound:** AC16/AC17
  pin the retry + orphan-recovery *requirements*; the durable-queue shape is one
  implementation — planner's choice.

### GPT adversarial pass — convergence (pass 5)

- Pass 5 returned `VERDICT=APPROVE` with **zero** findings on the revised draft;
  no new material weakness. Convergence reached.
- `GPT loop: 5 passes; stopped because no-accepted-finding-in-last-pass; last-pass accepted=0; final STATE=completed_valid VALIDATION=ok pass=a19571c7-3540-47a9-9ce7-07075247fb41 sha=50b19a54b3e22cee994daa24df7ab3fd68ea01e8ec243d842af61df4c45ee976`
- Pass state: `completed_valid` (passes 1–5). Total accepted findings: 19
  (pass1=5, pass2=5, pass3=5, pass4=4, pass5=0).

### Architect Codex review (post-GPT, max 5 iterations)

- **Iter 1:** P1 capture-tree allowed-roots conflict → resolved (canonical #366
  capture home; precedent #223/#352); P2 AC4 over-specified which gate catches a
  duplicate → loosened to claim-loss **or** cycle-gate suppression.
- **Iter 2:** P1 capture authorization made a **required in-scope** AGENTS.md edit
  (AC18), not a follow-up; P2 AC1 given a falsifiable seconds-scale bound.
- **Iter 3:** AC1 bound made **numeric (≤30s, receipt→createdAt)**; "retargeted"
  defined as **base-ref change**; AC1↔AC13 crash contradiction surfaced.
- **Iter 4 / 5:** AC13 restart recovery made falsifiable (**≤30s post-listener-ready
  when the durable record exists**, backstop only on record-loss). Iter 5 read
  clean but **coincided with the soft 5-cap** — not yet stable convergence.
- **Run-to-convergence (operator «до схождения»):** continued past the cap. A
  fresh cold pass caught two more: `#91` cited as a GitHub number (draft 91 =
  **#287**; same class fixed for draft-88→**#267**, draft-76→**#223**), and the
  AC12 verification covered only close/merge — added base-ref-change and CI-flip
  TOCTOU fixtures. **Two consecutive clean passes then confirmed convergence**
  (prose-clean → literal `NO_FINDINGS`). All three mechanical checks PASS. GPT
  5-pass APPROVE + Codex converged.
