# Script-owned review pipeline

This document describes the current pack-owned review path. It is supporting documentation; `AGENTS.md` and `scripts/pack-review-runner.ts` are authoritative when behavior differs.

## Review authority

Local Codex PR review is driven by the pack review runner. GitHub PR review is the authoritative verdict; the pack run store is operational state. Review start/list/status do not fall back to a concrete worker-runtime transport or a retired daemon API.

Automatic and common starts use:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --pr-number <PR_NUMBER> \
  --head-sha <HEAD_SHA>
```

Use the runner's `list`/status surfaces for run observation. Manual Browser-GPT review uses:

```bash
npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>
```

The review-start claim authority and run store prevent duplicate starts for one PR/head. A terminal result from another head is stale evidence; a clean terminal result for the exact current head is not re-invoked.

## Event-driven review trigger

The event-driven review trigger is a pack-owned decision: worker handoff state, required CI, exact PR/head binding, existing current-head review evidence, and the review-start claim are evaluated before a new run starts. A status transition alone is never permission to create a duplicate review run.

## Orchestrator review-run coverage

Review-run coverage is closed over the exact current PR head. A terminal run for another head is stale; a missing, failed, cancelled, malformed, or ambiguous current-head result is not clean evidence. The pack review runner and review-start claim authority own start/list/status behavior independently of worker runtime transport.

## Head ready for review

A head is ready for review only when the worker's exact PR/head binding is current and required CI is green. The pack must re-evaluate those facts at review start rather than trusting an earlier observation. Head drift invalidates the prior review target and requires a fresh current-head decision.

## Findings and delivery

The runner publishes review output through the pack-owned review path. A worker with delivered findings reports `addressing_reviews`, fixes the exact current head, then returns through required CI and current-head review before handoff. Missing, malformed, failed, cancelled, or ambiguous review evidence never becomes clean.

## CI and handoff

Required CI and review are independent obligations. Green CI is not a review verdict, and a clean review does not make red or missing required CI green. Workers must not report `ready_for_review` while required CI is red or missing.

Lifecycle state is reported through:

```text
pack-worker-report --state <ready_for_review|fixing_ci|addressing_reviews|completed|blocked>
```

The report store is pack-owned state. It is not a fallback source of runtime identity and does not authorize worker lifecycle effects.

## Runtime boundary

Worker/runtime effects require the selected `RuntimeAdapter` and exact `{ runtime, id, generation }` identity. Review start/list/status remain pack-review concerns and must not be implemented by reaching through that adapter to a concrete runtime-specific review service.

## Failure handling

- Failed or cancelled current-head review: inspect the bounded failure and retry only through the pack review runner's governed path.
- Head drift: prior review becomes stale; bind any new review to the new exact head.
- Missing current-head evidence: fail closed; do not synthesize a clean verdict.
- Open findings: fix or explicitly escalate under the governed waiver policy; never hand-edit the review-run store.

## Related docs

- [`AGENTS.md`](../AGENTS.md) — canonical worker review / CI / handoff contract.
- [`pack-review-waiver-merge-runbook.md`](pack-review-waiver-merge-runbook.md) — explicit operator waiver policy.
- [`orca-runtime-boundary.md`](orca-runtime-boundary.md) — runtime abstraction and narrow runtime-specific edges.
