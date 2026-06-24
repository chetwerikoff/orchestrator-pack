# NEW conflicting assertions on same binding identity

GitHub Issue: TBD

```contract-evidence
binding-id: orchestrator-pack:custom-field:first
binding: first NEW obligation
producer: orchestrator-pack
selector: custom-field
evidence: NEW(produced-by AC#1)
expected: x

binding-id: orchestrator-pack:custom-field:second
binding: conflicting NEW obligation
producer: orchestrator-pack
selector: custom-field
evidence: NEW(produced-by AC#1)
expected: y
```

## Acceptance criteria

1. Producer emits custom-field in reconciler output.

```producer-emission
producer: orchestrator-pack
datum: custom-field
expected: x
proof-command: npm test -- producer-emission
```
