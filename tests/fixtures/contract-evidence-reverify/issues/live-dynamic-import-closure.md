# Reverify fixture: dynamic import closure trust

GitHub Issue: #9017

## Goal

Fixture issue for checkpoint-2 capture row whose producer uses dynamic import().

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:scalar:dynamic-import-closure
binding: dynamic-import-closure fixture value
producer: orchestrator-pack-scripts
binding-type: structured
evidence: capture@dynamic-import-closure/match
selector: $
expected: match
```

## Acceptance criteria

1. Producer emits match when dynamically imported helper module is unchanged.
