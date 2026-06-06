# Positive-present action draft

GitHub Issue: TBD

## Goal

Wake the review listener when CI turns green.

```behavior-kind
action-producing
```

## Acceptance criteria

1. When CI is red, the listener records `defer: ci-red` and does not start a review run.

```positive-outcome
asserts: ao review run starts on green CI with an uncovered ready head
input: realistic
```

## Denylist

```denylist
vendor/**
```
