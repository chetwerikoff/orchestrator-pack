# Reverify fixture: producer unreachable

GitHub Issue: #9009

## Goal

Offline producer surfaces producer-unreachable.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:value
binding: unreachable producer
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@producer/unreachable
selector: $
expected: match
```

## Acceptance criteria

1. Unreachable producer never silently passes.
