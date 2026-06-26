# Orchestrator review pipeline aggregate process-spawn budget

GitHub Issue: [#480](https://github.com/chetwerikoff/orchestrator-pack/issues/480)

```behavior-kind
action-producing
```

```contract-evidence
binding-id: orchestrator-pack:review-pipeline-spawn-budget:journal-rate-attribution
binding-type: cli-behavior
binding: process-spawn measurement uses journal/rate evidence and attributes counts by source class instead of relying on point-in-time process snapshots
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:review-pipeline-spawn-budget:aggregate-budget
binding-type: cli-behavior
binding: a captured real-main orchestrator review pipeline tick/cycle reports total process spawns, derives a reduced budget from cadence times measured per-step cost, and fails when the aggregate budget is exceeded
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)

binding-id: orchestrator-pack:review-pipeline-spawn-budget:review-start-repeat-classifier
binding-type: cli-behavior
binding: repeated review-start attempts for the same PR are classified by PR, head, cycle, claim, and run state so same-cycle repeats are a regression and distinct-cycle starts are explainable
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
```

```positive-outcome
asserts: on a captured realistic main review-pipeline tick/cycle, process creation is measured by rate/event evidence, attributed by source class, reduced below the observed storm baseline by a cadence-times-cost budget, and same-PR review-start repeats are classified as regression or explainable distinct cycles
input: realistic
```

## Acceptance criteria

1. **Captured real-main aggregate budget exists, reduces baseline, and fails closed.**

```producer-emission
producer: orchestrator-pack
datum: review-pipeline-spawn-budget
expected: journal-rate-attribution
proof-command: pwsh -NoProfile -File scripts/check-review-pipeline-spawn-budget.ps1
```

```producer-emission
producer: orchestrator-pack
datum: review-pipeline-spawn-budget
expected: aggregate-budget
proof-command: pwsh -NoProfile -File scripts/check-review-pipeline-spawn-budget.ps1
```

2. **Review-start repeat classifier is deterministic.**

```producer-emission
producer: orchestrator-pack
datum: review-pipeline-spawn-budget
expected: review-start-repeat-classifier
proof-command: npx vitest run scripts/review-start-repeat-classifier.test.ts
```

## Verification

- `pwsh -NoProfile -File scripts/check-review-pipeline-spawn-budget.ps1`
- `npx vitest run scripts/review-pipeline-spawn-budget.test.ts scripts/review-start-repeat-classifier.test.ts`
