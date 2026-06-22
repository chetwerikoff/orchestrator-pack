# Reverify fixture: non-genuine proof

GitHub Issue: #9006

## Goal

Fixture issue for echo-only NEW proof.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack:reverify-status:verified
binding: echo-only proof
producer: orchestrator-pack
evidence: NEW(produced-by AC#1)
```

## Acceptance criteria

1. Proof must exercise producer path.

```producer-emission
producer: orchestrator-pack
datum: reverify-status
expected: verified
proof-command: REVERIFY_EXPECTED=verified node tests/fixtures/contract-evidence-reverify/producers/echo-expected.mjs
```
