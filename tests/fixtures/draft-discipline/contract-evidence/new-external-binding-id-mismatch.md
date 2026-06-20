# NEW with external binding-id producer disguised as repo-owned row

GitHub Issue: TBD

```contract-evidence
binding-id: ao:reportState:fixing_ci
binding: disguised external NEW row
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

## Acceptance criteria

1. Producer emits reportState in worker output.

```producer-emission
producer: ao
datum: reportState
expected: fixing_ci
proof-command: ao report addressing_reviews
```
