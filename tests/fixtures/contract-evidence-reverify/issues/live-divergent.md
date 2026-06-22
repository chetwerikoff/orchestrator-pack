# Reverify fixture: live divergent

GitHub Issue: #9002

## Goal

Fixture issue for checkpoint-2 divergent capture row.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:value
binding: scalar fixture value diverges from producer
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@structured/divergent-record
selector: $
expected: expected
```

## Acceptance criteria

1. Divergence surfaces asserted vs observed values.
