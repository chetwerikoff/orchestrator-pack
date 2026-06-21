# Reverify fixture: NEW fulfilled

GitHub Issue: #9004

## Goal

Fixture issue for fulfilled NEW row.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:reverify-status:verified
binding: reverify status verified
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

## Acceptance criteria

1. NEW obligation fulfilled live.

```producer-emission
producer: orchestrator-pack
datum: reverify-status
expected: verified
proof-command: REVERIFY_STATUS=verified node tests/fixtures/contract-evidence-reverify/producers/genuine-new-proof.mjs
```
