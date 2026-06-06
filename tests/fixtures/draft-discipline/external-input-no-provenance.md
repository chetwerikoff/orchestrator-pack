# External input without provenance

GitHub Issue: TBD

## Goal

Bind review readiness to AO report shape.

```behavior-kind
action-producing
```

## Acceptance criteria

```positive-outcome
asserts: head-ready predicate is eligible when the AO report omits headRefOid
input: external-tool-output
```

## Denylist

```denylist
vendor/**
```
