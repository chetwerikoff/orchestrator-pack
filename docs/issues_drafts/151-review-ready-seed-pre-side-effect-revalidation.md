# Review-ready seed must revalidate eligibility immediately before side effects

GitHub Issue: #475

## Prerequisite

- `docs/issues_drafts/123b-review-ready-report-state-seed-backstop.md` (GitHub
  [#391](https://github.com/chetwerikoff/orchestrator-pack/issues/391), **closed**) —
  defines the state-derived seed path for accepted `ready_for_review` reports.
- `docs/issues_drafts/150-review-ready-seed-long-tick-liveness-heartbeat.md` (GitHub
  [#473](https://github.com/chetwerikoff/orchestrator-pack/issues/473), **open**) —
  restores liveness for long seed ticks. **This draft is separate:** a heartbeat can keep a
  long tick alive while its original AO/GitHub eligibility snapshot becomes stale.
- Existing review-start idempotency / readiness work (#189, #195, #207, #235, #381) is
  reused. This draft does not redefine the classifier; it requires the seed path to
  re-read the authoritative predicate before side effects.

**Prior-art verdict:** **Extends existing review-start TOCTOU contracts for the seed path.**
No existing draft specifically owns the long-tick seed case where scan/planning eligibility
is valid at the start of the tick but stale by the time the side effect would run.

## Goal

Before `review-ready-report-state-seed` performs a review-start side effect derived from a
long-running scan/planning tick, it must revalidate the relevant readiness, head, PR,
dedupe, and claim inputs against fresh authoritative state. A candidate that became stale
mid-tick must skip/defer with structured evidence, not start review.

```behavior-kind
action-producing
```

## Binding surface

- **Immediate pre-side-effect revalidation:** The seed path may discover candidates from a
  scan snapshot, but before starting review or committing equivalent side-effect state it
  re-reads the current authoritative predicate needed by the existing #391/#195/#189/#235
  contracts.
- **TOCTOU outcomes are structured:** if PR/head/readiness/coverage/claim state changed
  after scan/planning, the candidate is skipped or deferred with reason. No stale review
  action is emitted.
- **No duplicate side effects:** revalidation composes with existing dedupe / claim guards;
  concurrent seed/reconcile/listener paths still have a single winner.
- **Planner freedom:** the planner chooses whether revalidation happens under an existing
  lock, immediately before invoking the side effect, or through an equivalent fresh
  snapshot boundary. Equivalent means no authoritative head/readiness/coverage/claim change
  can intervene between the final revalidation read and the side effect; a change at that
  boundary must block the side effect or lose the claim. The spec defines behavior, not
  helper names.

## Files in scope

- `scripts/**` — seed-path revalidation behavior, existing readiness/claim integration,
  tests/fixtures.
- `tests/external-output-references/**` — redacted/generated external-output samples if
  the planner needs persistent fixtures outside `scripts/**`.
- `docs/**` — runbook or migration note if operator-visible.

## Files out of scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- `agent-orchestrator.yaml`
- Heartbeat/watchdog liveness from #150 except as a prerequisite.
- GitHub inventory cache from #453.

```denylist
vendor/**
packages/core/**
.ao/**
agent-orchestrator.yaml
```

Scope boundary note: This denylist is scoped to `151-review-ready-seed-pre-side-effect-revalidation`.

```allowed-roots
scripts/**
tests/external-output-references/**
docs/**
```

## Acceptance criteria

1. **Fresh success path:** candidate discovered by seed scan remains current and eligible at
   pre-side-effect revalidation; exactly one review-start side effect proceeds.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-revalidation
expected: fresh-candidate-starts
proof-command: npm test -- review-ready-seed-revalidation
```

2. **Head changed mid-tick:** candidate was eligible at scan time, but PR head changed
   before side effect; revalidation rejects with structured `stale-head` / equivalent
   reason and emits no review start.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-revalidation
expected: stale-head-rejected
proof-command: npm test -- review-ready-seed-revalidation
```

3. **Readiness changed mid-tick:** report/head is no longer #195-ready before side effect
   (CI red/unknown, draft/closed/merged, stale report binding, or equivalent existing
   classifier reason); revalidation skips/defer with structured reason.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-revalidation
expected: readiness-revalidated
proof-command: npm test -- review-ready-seed-revalidation
```

4. **Already covered / claim won elsewhere:** another path covered the head or won the
   review-start claim after seed planning; revalidation emits no duplicate start and
   records structured loser/dedupe evidence.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-revalidation
expected: duplicate-prevented
proof-command: npm test -- review-ready-seed-revalidation
```

5. **Boundary-race fixture:** a deterministic fixture mutates head/readiness/claim state at
   the latest supported pre-side-effect boundary; the seed path emits no stale review start
   and records a structured stale/claim-lost outcome.

```producer-emission
producer: orchestrator-pack
datum: review-ready-seed-revalidation
expected: boundary-race-blocked
proof-command: npm test -- review-ready-seed-revalidation
```

```positive-outcome
asserts: when a seed-planned candidate remains ready/current at immediate pre-side-effect revalidation, exactly one review-start side effect proceeds; when head/readiness/coverage/claim state changes mid-tick, no stale or duplicate review start is emitted and a structured skip/defer reason is recorded
input: realistic
```

## Upgrade-safety check

- No AO core or vendor edits.
- Reuses existing readiness and claim semantics instead of introducing a second classifier.
- No new secrets or raw AO/GitHub payload persistence.
- Works whether #150 implements heartbeat-only or a cheap-poll / expensive-worker split.

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:review-ready-seed-revalidation:fresh-candidate-starts
binding-type: cli-behavior
binding: a seed-planned candidate that remains current and eligible at immediate pre-side-effect revalidation starts exactly once
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:review-ready-seed-revalidation:stale-head-rejected
binding-type: cli-behavior
binding: a candidate whose head changed between scan/planning and side effect is rejected without review start
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:review-ready-seed-revalidation:readiness-revalidated
binding-type: cli-behavior
binding: a candidate that is no longer ready at pre-side-effect revalidation is skipped or deferred with structured reason
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)

binding-id: orchestrator-pack:review-ready-seed-revalidation:duplicate-prevented
binding-type: cli-behavior
binding: a candidate already covered or claimed by another path after planning does not start a duplicate review
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)

binding-id: orchestrator-pack:review-ready-seed-revalidation:boundary-race-blocked
binding-type: cli-behavior
binding: a candidate whose authoritative state changes at the latest supported pre-side-effect boundary does not emit a stale review start
producer: orchestrator-pack
evidence: NEW(produced-by AC#5)
```

## Verification

- `npm test -- review-ready-seed-revalidation`
- `npm test -- review-trigger-reeval`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/151-review-ready-seed-pre-side-effect-revalidation.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/151-review-ready-seed-pre-side-effect-revalidation.md`
- `pwsh -NoProfile -File scripts/verify.ps1`
- `pwsh -NoProfile -File scripts/check-reusable.ps1`

## Decisions

- Split from #150 to keep the heartbeat/liveness fix implementable. This is a real
  correctness issue, but not required to define the watchdog heartbeat invariant.
- Revalidation should reuse existing #195/#189/#235/#391 predicates and claim semantics.
  A second readiness classifier would be a regression.

## Planner-freedom checklist

- [ ] No required function signature or import path.
- [ ] No prescribed folder layout beyond allowed roots.
- [ ] No pinned library version.
- [ ] Acceptance criteria are behaviorally verifiable by tests or live commands, not by
      architect-only diff reading.
