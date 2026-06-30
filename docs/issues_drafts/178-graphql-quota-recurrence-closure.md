# GraphQL quota recurrence closure for orchestrator GitHub reads

GitHub Issue: [#549](https://github.com/chetwerikoff/orchestrator-pack/issues/549)

```behavior-kind
action-producing
```

## Goal

After #540 and #546 ship, every orchestrator-pack GitHub read path that can run during autonomous review start, wake-supervisor reconciliation, worker claim/spawn, RCA/review triage, or reviewer context hydration is classified as one of: REST-routed inventory, GraphQL fail-fast/degraded, or explicitly accepted upstream GraphQL residual. New unclassified `gh` read shapes or `gh api graphql` consumers must fail CI/review before they can recreate a runtime GraphQL-quota incident.

## Acceptance criteria

1. **Inventory completeness:** `scripts/lib/graphql-quota-github-read-inventory.json` lists every executable GitHub read shape found in tracked pack-owned scripts/prompts/runbooks in scope and classifies each row as `rest_inventory`, `graphql_fail_fast`, `rest_direct`, or `accepted_upstream_residual`.

```producer-emission
producer: orchestrator-pack
datum: graphql-quota-github-read-inventory
expected: all-in-scope-read-shapes-classified
proof-command: npx vitest run scripts/gh-inventory-static-guard.test.ts
```

2. **GraphQL-exhausted drill:** with native GraphQL mocked/exhausted, representative autonomous review-start and wake-supervisor read paths complete the safe branches: REST inventory reads succeed, #540-owned GraphQL calls fail fast without repeated network GraphQL, and residual GraphQL-only calls produce structured degraded/audit output.

```producer-emission
producer: orchestrator-pack
datum: graphql-quota-drill
expected: no-repeated-network-graphql-after-primary-quota-exhaustion
proof-command: npx vitest run scripts/gh-wrapper.test.ts scripts/review-start-envelope-external-io.test.ts
```

```positive-outcome
asserts: under a GraphQL-primary-quota-exhausted harness, orchestrator GitHub read paths either complete through REST inventory or enter a bounded degraded state with an owning residual class, without repeated native GraphQL attempts
input: realistic
```

3. **New read-shape guard:** a fixture that adds an uncovered executable `gh pr view 123 --json unknownField` or an unowned `gh api graphql` call fails verification; the same guard passes for classified inventory shapes, explicit direct REST reads, and documented accepted residuals.

```producer-emission
producer: orchestrator-pack
datum: gh-inventory-static-guard
expected: new-read-shape-and-graphql-owner-guard
proof-command: npx vitest run scripts/gh-inventory-static-guard.test.ts
```

4. **Residual ownership:** every accepted upstream GraphQL residual row cites a follow-up owner or an explicit "accepted until upstream replacement" policy. A residual row without an owner fails the inventory check.

5. **No workaround regression:** verification fails if agent-facing text or scripts authorize temp `gh` wrappers, raw `curl api.github.com`, `gh api graphql` fallback, `unset GH_WRAPPER_ACTIVE`, or direct bash REST branches outside the wrapper/inventory machinery.

6. **#540/#546 regression coupling:** the drill includes the two June 30 classes: passthrough `gh api graphql` churn and `pr-view` head-ref field-set passthrough. If either prerequisite regresses, this draft's verification fails.

```contract-evidence
binding-id: orchestrator-pack:graphql-quota-github-read-inventory:all-in-scope-read-shapes-classified
binding-type: cli-behavior
binding: in-scope executable GitHub read shapes are classified as REST inventory, direct REST, GraphQL fail-fast, or accepted upstream residual
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

```contract-evidence
binding-id: orchestrator-pack:graphql-quota-drill:no-repeated-network-graphql-after-primary-quota-exhaustion
binding-type: cli-behavior
binding: GraphQL-exhausted drill proves covered reads avoid repeated native GraphQL and residuals degrade visibly
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)
```

```contract-evidence
binding-id: orchestrator-pack:gh-inventory-static-guard:new-read-shape-and-graphql-owner-guard
binding-type: cli-behavior
binding: static guard fails on uncovered executable gh read shapes and unowned gh api graphql calls
producer: orchestrator-pack
evidence: NEW(produced-by AC#3)
```
