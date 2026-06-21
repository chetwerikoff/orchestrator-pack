# Reverify fixture: runtime file driven live match

GitHub Issue: #9015

## Goal

Fixture issue for checkpoint-2 live verified capture row whose producer reads PR-local data.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:runtime-file
binding: runtime file fixture value
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@structured/runtime-file-match
selector: $
expected: match
```

## Acceptance criteria

1. Producer still emits match at review time when runtime file is unchanged.
