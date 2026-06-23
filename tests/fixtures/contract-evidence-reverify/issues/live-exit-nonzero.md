# Reverify fixture: structured producer exits nonzero

GitHub Issue: #9012

## Goal

Fixture issue for nonzero structured producer exit with matching stdout.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:value
binding: scalar fixture value
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@structured/exit-nonzero
selector: $
expected: match
```

## Acceptance criteria

1. Producer stdout matches but exit code is nonzero.
