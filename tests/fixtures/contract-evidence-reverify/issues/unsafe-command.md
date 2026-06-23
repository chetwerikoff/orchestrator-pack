# Reverify fixture: unsafe command

GitHub Issue: #9010

## Goal

Unsafe command falls back to compared-to-record when capture exists.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:value
binding: unsafe live command
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@producer/unsafe
selector: $
expected: match
```

## Acceptance criteria

1. Unsafe command is not executed live.
