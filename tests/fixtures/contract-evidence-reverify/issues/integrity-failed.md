# Reverify fixture: integrity failed

GitHub Issue: #9008

## Goal

Manifest hash mismatch is terminal.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:value
binding: integrity mismatch row
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@structured/integrity-mismatch
selector: $
expected: match
```

## Acceptance criteria

1. Integrity failure blocks producer comparison.
