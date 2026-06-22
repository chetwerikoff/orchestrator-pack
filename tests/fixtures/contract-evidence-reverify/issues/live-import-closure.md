# Reverify fixture: import closure trust

GitHub Issue: #9016

## Goal

Fixture issue for checkpoint-2 capture row whose producer imports a local helper module.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:import-closure
binding: import-closure fixture value
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@import-closure/match
selector: $
expected: match
```

## Acceptance criteria

1. Producer emits match when helper module is unchanged.
