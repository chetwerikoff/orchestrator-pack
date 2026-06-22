# Reverify e2e fixture issue snapshot

GitHub Issue: #376

## Goal

End-to-end reviewer checkpoint-2 fixture.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:value
binding: e2e verified row
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@structured/match
selector: $
expected: match

binding-id: orchestrator-pack-scripts:scalar:value2
binding: e2e runtime-file verified row
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@structured/runtime-file-match
selector: $
expected: match
```

## Acceptance criteria

1. Reviewer receives per-row checkpoint-2 summary.
