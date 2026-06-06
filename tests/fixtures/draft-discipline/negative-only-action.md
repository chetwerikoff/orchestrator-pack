# Negative-only action draft

GitHub Issue: TBD

## Goal

Wake the review listener when CI turns green.

```behavior-kind
action-producing
```

## Acceptance criteria

1. When CI is red, the listener records `defer: ci-red` and does not start a review run.
2. When the head is already covered, the listener records `defer: head-covered`.

## Denylist

```denylist
vendor/**
```
