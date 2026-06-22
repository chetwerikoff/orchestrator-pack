# State-derived review-start seed when accepted ready_for_review has no consumed webhook (co-primary backstop)

GitHub Issue: #391

## Prerequisite

**Merge first:** #390 (`123a-review-pending-info-handoff-admission.md`) — live
`review.pending` admission + `capture@ao-webhook-notification/review_pending` in
`b213c57`.

Reused: #381 handoff chain; #235 deferred-head watch / poll reeval; #195 + #352
readiness classifier; #205 supervised side-processes; #223 fixture discipline. #163
reconcile = backstop for zero-signal heads only.

## Pre-sync grounding (Gate A — complete)

**Captured in `bc012d8`:** `capture@ao-status-sessions/ready_for_review_on_head`.
`contract-evidence` PASS; manifest + snapshot semantics checks PASS on current `main`.
Re-capture only if invalidated. Prerequisite: `123a` webhook capture in `b213c57`.

### Producer reality (AO 0.9.2 `ao status --json --reports full`)

Verified on `bc012d8` fixture:

- Top-level array is **`data[]`** (not `sessions[]`).
- Session rows carry `branch`, `pr` / `prNumber`, `reports[]` — **no head SHA field**.
- Report rows carry `timestamp`, `reportState`, `accepted`, `prNumber`, `before` /
  `after` transition metadata — **no per-report head SHA**. Text in `note` is not a
  binding surface.

**Implication:** poll input is status JSON for *which session reported what and when*;
**current head SHA is resolved out-of-band** (git/gh from `branch` + `prNumber`). Report-to-head
binding uses **observed report-bound head** (poll invariant below), not phantom fields in status JSON.

## Goal

Close the **no-webhook** half of #381: when AO accepts `ao report ready_for_review` but
the pack has no terminal handoff outcome, a supervised poll path MUST seed bounded #235
reeval and start first review within seconds — machine-distinct `startReason` from
`handoff_wake`, `completion_wake`, and `periodic=reconcile`.

RCA: dozens of accepted `ready_for_review` reports, **zero** `review_pending` webhooks on
the common path. Co-primary with `123a`, not a rare backstop.

```behavior-kind
action-producing
```

```contract-evidence
binding-id: ao:report:ready_for_review:accepted
binding-type: structured
binding: Accepted ao report ready_for_review result (grounding-lane: grounded-now; existing corpus)
producer: ao
evidence: capture@ao-worker-report/ready_for_review
selector: $.accepted
expected: true

binding-id: ao:report:ready_for_review:reportState
binding-type: structured
binding: Report state on accepted ready_for_review (grounding-lane: grounded-now; existing corpus)
producer: ao
evidence: capture@ao-worker-report/ready_for_review
selector: $.reportState
expected: ready_for_review

binding-id: ao:webhook:event.type:review.pending
binding-type: structured
binding: Shared 123a webhook producer shape (seed-path tests; grounds event.type only — not “webhook absent”)
producer: ao
evidence: capture@ao-webhook-notification/review_pending
selector: $.event.type
expected: review.pending
```

> Literal rows only. Full `ao status` poll-input shape (`data[]`, reports, timestamps) is
> a **recurrence-test fixture** (`bc012d8`), not a `contract-evidence` row.

## Binding surface

- **Seed when no terminal handoff outcome.** After an accepted `ready_for_review` report
  that satisfies the poll binding invariant (below), with no terminal handoff receipt /
  review-start claim for `(repoSlug, prNumber, resolvedHeadSha)`, poll writes a durable
  seed and invokes bounded #235 reeval.
- **Poll input.** Seconds-scale supervised poll reads
  `ao status --json --reports full --include-terminated`; scans `data[]` (or `sessions[]` if
  AO adds it). Use terminated rows when the producer returns them — do not drop session rows
  the command includes.
- **Head SHA — out-of-band.** Current head resolved via git/gh from `branch` + `prNumber`.
  Status JSON has no head SHA; do not parse `note` text.
- **Report-to-head binding (poll invariant).** An accepted report binds to the **current**
  resolved head only if it is a **newly observed report event** created **not earlier than**
  when the poller first observed the **current tip**. A report that predates a tip change
  MUST NOT bind to the new tip; on tip change, any prior binding for that key is cleared.
  Seed write is forbidden when the latest accepted report is not bound to the current
  resolved head. (Planner chooses durable state shape and tick ordering that satisfy this
  invariant — including bootstrap across poll-child restart.)
- **Evaluate (second fence).** #195 + #352 / `review-head-ready.mjs` (#74) decide whether
  a bound candidate may start; seed only triggers reeval. Classifier MUST reject stale or
  mis-bound heads even if poll admitted a candidate.
- **Seed dedupe.** One durable seed per `(supervisedProject, repoSlug, prNumber,
  resolvedHeadSha, reportState)` — session-agnostic; `resolvedHeadSha` from git/gh.
- **Double-start guard.** Existing review-start claims (#267/#308) and #195/#352 readiness —
  not reimplemented in the seed layer.
- **Non-terminal webhook defer stays seed-eligible.** **Terminal vs transient:** same
  source of truth as `123a` — `docs/review-head-ready.mjs` + `docs/review-trigger-reeval.mjs`
  (#235).
- **Poll scope.** Scan all eligible heads honestly — no silent drops; when a tick cannot
  finish all eligible heads, deferred heads MUST be revisited on later ticks (planner picks
  per-tick limits and logging).
- **CI-defer recovery.** Poll retries on seconds-scale ticks while the accepted report
  remains observable and binding-eligible; CI green on a later tick may start without
  reconcile.

## Files in scope

- Supervised poll child, #235 seed/watch persistence, seed-path tests.
- Recurrence fixture references `capture@ao-status-sessions/ready_for_review_on_head`.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`, `agent-orchestrator.yaml`.
- Live `review.pending` admission — `123a`.
- Worker never reaches `ready_for_review` — #195 ceiling.

## Operator adoption

After implementation PR merges, restart the full draft-71 supervised side-process set
(listener + poll child) from the same checkout.

## Denylist / allowed-roots

Same as #390 (`123a-review-pending-info-handoff-admission.md`) — `vendor/**`, `packages/core/**`, `.ao/**`, `agent-orchestrator.yaml` denied; `scripts/**`, `plugins/**`, `docs/**`, `tests/external-output-references/**` allowed.

## Acceptance criteria

```positive-outcome
asserts: with webhooks and reconcile disabled in harness, when #195-ready on current head (accepted report bound to current resolved head per poll invariant, required CI green, head not covered), poll observation produces machine-distinct seed-path startReason and terminal review-start claim within ≤30s — not periodic=reconcile
input: external-tool-output
provenance: capture-backed
```

- **Seed path recurrence (Gate B, #195-ready):** test with `bc012d8` fixture shape
  (`data[]`, out-of-band head resolve stubbed to fixture provenance `headSha`) proves
  seed-path start ≤30s when #195-ready.
- **CI-defer then start (Gate B):** CI not green → structured defer; poll keeps ticking;
  within ≤30s after CI green on any subsequent tick, seed-path start without reconcile.
- **No-webhook negative control (Gate B):** harness disables webhook ingress; no handoff
  receipt before seed.
- **Terminal-outcome negative controls (Gate B):** existing terminal handoff receipt or
  review-start claim for the same `(repoSlug, prNumber, resolvedHeadSha)` → no new seed.
- **Stale-report negative controls (Gate B):**
  - **A→B race:** report accepted on head A, tip advances to B before poller observed B —
    report predates current-tip observation → no bind, no seed;
  - same accepted report after tip change (no new report event) → prior binding cleared; no
    seed until a new report binds on the new tip;
  - seed forbidden when bound head ≠ current resolved head;
  - classifier negative: mis-bound or stale head → evaluate defers, no claim.
- **Terminated-session (Gate B):** when the producer returns an accepted `ready_for_review`
  report **only** in a terminated session row (`--include-terminated`), poll **MUST** seed
  when otherwise eligible — harness proves the row is not dropped.
- **Eventual scan (Gate B):** when eligible heads exceed per-tick capacity, harness proves
  deferred heads are revisited on later ticks (no infinite prefix-only scan while logging).
- **Classifier negative control (Gate B):** poll candidate present but #352/#195 classifies
  head stale or covered → evaluate defers; no erroneous start.
- **Multi-repo isolation:** same supervised project, **distinct `repoSlug`**, colliding
  `(prNumber, resolvedHeadSha)` → separate seeds.
- **Concurrency:** parallel seed for same dedupe key → one durable watch entry.
- **Scenario matrix:**

| Condition | Expected |
|-----------|----------|
| Fresh accepted report, no webhook, #195-ready | Seed-path start ≤30s; no reconcile |
| Accepted report, #195-not-ready (e.g. CI red) | Defer; start ≤30s after CI green observed |
| Listener down; report accepted | Poll seeds when #195-ready |
| Webhook deferred transiently; report later accepted | Poll starts when #195-ready without new webhook |
| A→B race: report predates observed tip B | No bind; no seed |
| Tip B; same old report (no new event) | Binding cleared; no seed until new report on B |
| Bound head ≠ current resolved head | No seed |
| Terminated row only; otherwise eligible | MUST seed (row not dropped) |
| Eligible heads exceed per-tick capacity | Deferred heads revisited on later ticks |
| Poll candidate present; #352 says stale/covered | Evaluate defers; no start |

## Verification

**Pre-sync:**

- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md`
- Manifest integrity + snapshot semantics (PASS on `main` post-`bc012d8`; see capture
  provenance). Prerequisite: `123a` capture in `b213c57`.

**Post-sync:**

- `npm test -- --run scripts/review-trigger-reeval.test.ts`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md`
- Guards wired into `scripts/verify.ps1`

## Decision log

- **Co-primary with 123a** — common path has no webhook.
- **Head-binding fix (2026-06-22):** `data[]` + timestamps only; head out-of-band; poll
  binding invariant + #352 evaluate fence. `headSha` in `bc012d8` provenance is test annotation.
- **Altitude trim (2026-06-22):** removed pseudo-implementation (field names, tick steps,
  eventCutoff arithmetic); invariant + matrix + negative ACs are the spec.
- **Architect review (2026-06-22):** P1 head-race closed at invariant level; no further
  full Codex cycles planned (diminishing returns).
