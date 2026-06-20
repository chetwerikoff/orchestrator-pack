# Grounded contract-evidence draft

GitHub Issue: TBD

## Goal

Example draft with capture-backed contract evidence.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: ao:reportState:fixing_ci
binding: ao worker report fixing_ci state
producer: ao
evidence: capture@ao-worker-report/fixing_ci
selector: $.reportState
expected: fixing_ci
```

## Acceptance criteria

1. Suppress CI failure ping when worker reports fixing_ci.

```positive-outcome
asserts: ping suppressed when latest report is fixing_ci
input: external-tool-output
provenance: capture-backed
```

## Denylist

```denylist
vendor/**
```
