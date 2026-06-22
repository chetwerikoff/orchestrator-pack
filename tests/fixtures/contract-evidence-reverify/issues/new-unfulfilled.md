# Reverify fixture: NEW unfulfilled

GitHub Issue: #9005

## Goal

Fixture issue for unfulfilled NEW row.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:reverify-status:verified
binding: reverify status should be verified
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

## Acceptance criteria

1. Producer does not emit expected datum.

```producer-emission
producer: orchestrator-pack
datum: reverify-status
expected: verified
proof-command: REVERIFY_STATUS=divergent node tests/fixtures/contract-evidence-reverify/producers/genuine-new-proof.mjs
```
