# Admit live AO 0.9.2 review.pending(info) hand-off webhooks through handoff admission (recurrence fix for #381)

GitHub Issue: #390

## Prerequisite

Reused (merged / queued — not re-implemented here):

- #381 (`120-event-driven-review-trigger-on-ready-for-review-handoff.md`) — handoff
  admission, identity binding, #195/#267/#308/#332, handoff receipt, structured audit.
  **Gap:** live AO emits `review.pending` at `info`, not `session.working` +
  `semanticType: ready_for_review`; `handoff_wake` count is zero.
- #218 (`74-review-head-ready-report-sha-independent-binding.md`) — synthetic vs live wire.
- #195, #267, #308, #332, #352 — readiness, claim, cycle, classifier (consume, don't fork).
- #223 — representative capture discipline.
- **Follows this draft:** #391 (`123b-review-ready-report-state-seed-backstop.md`) — no-webhook seed.
- #163 reconcile stays backstop for zero-signal heads only.

## Pre-sync grounding (Gate A — complete)

**Captured in `b213c57`:** `capture@ao-webhook-notification/review_pending`
(`representative: true`). `contract-evidence` PASS on current `main`. Re-capture only if
the fixture is invalidated.

Gate **B** (implementation) reuses that capture — planner must not synthesize a
representative wire body.

### Producer-source (@aoagents/ao-core@0.9.2, supplements wire capture)

| Field | Proof |
|-------|-------|
| `event.type: review.pending` | `lifecycle-manager.js` `statusToEventType` |
| `semanticType: review.pending` | `notification-data.js` `buildSessionTransitionNotificationData` |
| `priority: info` | `inferPriority("review.pending")` |
| Webhook on transition only | `notifyHuman` when `oldStatus !== newStatus` |

## Goal

When AO 0.9.2 emits a qualified `review.pending` at `info`, the wake listener MUST route
it through handoff admission and the existing #195 → #267/#308/#332 chain so first review
can start with `startReason: handoff_wake` within seconds — not `dropped: info_priority`
solely because `priority` is `info`.

RCA: admission predicate expected #381's synthetic shape; live wire is `review.pending` /
`info` (#212→#218). Shipped `ready_for_review` webhook capture was wrongly representative.

```behavior-kind
action-producing
```

```contract-evidence
binding-id: ao:webhook:event.type:review.pending
binding-type: structured
binding: AO 0.9.x webhook event.type on transition to review_pending (grounding-lane: grounded-now)
producer: ao
evidence: capture@ao-webhook-notification/review_pending
selector: $.event.type
expected: review.pending

binding-id: ao:webhook:event.data.semanticType:review.pending
binding-type: structured
binding: AO 0.9.x webhook semanticType on review_pending transition (grounding-lane: grounded-now)
producer: ao
evidence: capture@ao-webhook-notification/review_pending
selector: $.event.data.semanticType
expected: review.pending

binding-id: ao:webhook:event.priority:info
binding-type: structured
binding: AO review.pending webhook transport priority (grounding-lane: grounded-now)
producer: ao
evidence: capture@ao-webhook-notification/review_pending
selector: $.event.priority
expected: info

binding-id: ao:webhook:event.data.schemaVersion:3
binding-type: structured
binding: AO schemaVersion 3 notification subject layout (grounding-lane: grounded-now; wire-only field)
producer: ao
evidence: capture@ao-webhook-notification/review_pending
selector: $.event.data.schemaVersion
expected: 3
```

> Literal producer-value discriminators only (#366). Wire-shape assertions
> (`subject.session.id`, `subject.pr.number`) and the synthetic #381 negative control
> live in recurrence tests, not in this block. Checker shape-predicate gap → separate
> gate-tooling follow-up (Decision log).

## Binding surface

- **Qualified admission** — not by removing the global `info` drop. Qualification =
  four contract-evidence discriminators **plus** identity-bound handoff admission per
  #381. Qualified envelopes enter the same #195 evaluate path as #381's synthetic
  envelope; unqualified `info` still drops or rejects.
- **Single handoff path.** Qualified `review.pending(info)` is admitted only through
  handoff admission — it MUST NOT also be processed by the existing
  `review.pending` → `review.needs_triage` mapping (no double handling).
- **Ordering defect, not wake-kind mapping.** Qualified envelopes reach evaluate and
  produce `startReason: handoff_wake` or auditable defer — never bare `info` promotion.
- **#195 gate unchanged.** Start stays gated by shared readiness (#195 + #352).
- **Webhook idempotency.** Replay structured no-op only after a **terminal** outcome for
  that PR+head: review-start claim, or a defer that cannot change until the head advances.
  **Transient** defers (readiness can change without a new push) MUST allow
  re-evaluation. **Source of truth for terminal vs transient:** existing readiness /
  defer classifier in `docs/review-head-ready.mjs` and deferred-reeval eligibility in
  `docs/review-trigger-reeval.mjs` (#235) — same interpretation as `123b`; do not fork
  string taxonomies in this draft.
- **Fixture discipline.** Primary recurrence uses Gate A wire capture; synthetic
  `ready_for_review` webhook capture stays `representative: false` (negative control).

## Files in scope

- Wake-listener handoff admission path (filter + envelope admission for live
  `review.pending`).
- Recurrence tests and CI guards for live wire fixture and representative discipline.

## Files out of scope

- `vendor/**`, `packages/core/**`, `.ao/**`, `agent-orchestrator.yaml`.
- State-derived seed when no webhook — `123b`.
- Worker never reaches `ready_for_review` — #195 ceiling.
- Removing global `info` drop; changing #163 reconcile interval.

## Operator adoption

After implementation PR merges, restart supervised side-processes so the listener loads
new admission code.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
plugins/**
docs/**
tests/external-output-references/**
```

## Acceptance criteria

```positive-outcome
asserts: on production-representative review_pending webhook fixture (Gate A wire capture, priority info), listener handoff admission never returns dropped: info_priority solely because priority is info — qualified envelopes enter handoff evaluate
input: external-tool-output
provenance: capture-backed
```

- **Live envelope admission (Gate B):** `capture@ao-webhook-notification/review_pending`
  passes handoff probe and enters #195 evaluate — not `info_priority` drop.
- **#195-ready recurrence (Gate B):** harness with #195 satisfied on current head proves
  `startReason: handoff_wake` and terminal review-start claim within ≤30s of qualified
  webhook receipt — no `periodic=reconcile` between receipt and claim.
- **#195-not-ready defer (Gate B):** when #195 is not satisfied (and not idempotent
  replay), structured #195 defer with auditable reason — still not `info_priority` drop.
- **Info-storm negative control:** generic `info` without hand-off semantic → `info_priority`.
- **Discriminator negative controls (Gate B)** — each fails qualification independently;
  must not enter handoff evaluate as if qualified:
  - wrong `event.type` (not `review.pending`);
  - wrong `semanticType` (not `review.pending`);
  - wrong `priority` (not `info` on an otherwise handoff-shaped envelope);
  - wrong `schemaVersion` (not `3`).
- **Admission reject (identity-invalid):** foreign session, malformed subject, or missing
  session/PR identity — reject before #195 evaluate.
- **No double handling (Gate B):** qualified `review.pending(info)` produces
  `handoff_wake` or #195 defer only — observable proof that `review.needs_triage` (legacy
  mapping path) was **not** invoked for the same envelope.
- **Webhook idempotency:** replay after terminal outcome → structured no-op; transient
  defer and first-pass not-ready still re-evaluable.
- **Manifest honesty:** `review_pending` representative; `ready_for_review` webhook not.

## Verification

**Pre-sync:**

- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/123a-review-pending-info-handoff-admission.md`

**Post-sync:**

- `npm test -- --run scripts/review-handoff-wake-trigger.test.ts`
- `pwsh -NoProfile -File scripts/check-review-wake-trigger.ps1`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/123a-review-pending-info-handoff-admission.md`
- Guards wired into `scripts/verify.ps1`

## Decision log

- **Decomposed from draft 123** — webhook half; seed is `123b`.
- **contract-evidence:** four literal `review.pending` discriminators grounded by
  `b213c57`; shape rows rejected (literal-only checker, #366).
- **Gate A complete** (`b213c57`). Architect review converged 2026-06-21; trimmed 2026-06-22
  (defer property, dual-path, collapsed capture procedure; discriminator negative ACs).
