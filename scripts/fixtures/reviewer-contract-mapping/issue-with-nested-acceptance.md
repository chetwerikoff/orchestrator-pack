## Goal

Example contract with nested bullet acceptance criteria.

```behavior-kind
action-producing
```

## Binding surface

- Nested bullets stay attached to their parent criterion.

## Files in scope

```denylist
vendor/**
```

```allowed-roots
scripts/fixtures/**
```

## Acceptance criteria

- Parent criterion with nested supporting bullets
  - Supporting detail one for the parent
  - Supporting detail two for the parent
- Second top-level criterion stands alone

## Verification

1. Run nested acceptance-criteria parsing fixtures.

```positive-outcome
asserts: nested bullets remain one parent criterion
input: realistic
```
