## Goal

Example contract with bullet-style acceptance criteria.

```behavior-kind
action-producing
```

## Binding surface

- Example binding for bullet fixture tests.

## Files in scope

```denylist
vendor/**
```

```allowed-roots
scripts/**
```

## Acceptance criteria

- First bullet acceptance criterion for fixture mapping.
- Second bullet acceptance criterion for fixture mapping.
- [ ] Checkbox acceptance criterion remains testable.
- [x] Completed checkbox acceptance criterion is also parsed.

## Verification

1. Run reviewer contract-mapping fixtures.

```positive-outcome
asserts: bullet fixture produces candidate ledger entries
input: realistic
```
