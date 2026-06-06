# Synonym backstop draft

GitHub Issue: TBD

## Goal

The supervisor reconciles listener wake retries when merge intent arrives.

```behavior-kind
record-only
```

## Acceptance criteria

1. The reconcile script logs defer reasons without enqueueing side effects.

## Denylist

```denylist
vendor/**
```
