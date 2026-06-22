# Reverify fixture: live match

GitHub Issue: #9001

## Goal

Fixture issue for checkpoint-2 live verified capture row.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:value
binding: scalar fixture value
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@structured/match
selector: $
expected: match
```

## Acceptance criteria

1. Producer still emits match at review time.
