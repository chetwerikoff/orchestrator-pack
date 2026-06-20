## Goal

Example contract with bullet-style acceptance criteria for mapping ledger tests.

```behavior-kind
action-producing
```

## Binding surface

- Bullet-style AC parsing must recognize `-`, `*`, and checkbox list markers.

## Files in scope

```denylist
vendor/**
packages/core/**
```

```allowed-roots
scripts/fixtures/**
```

## Acceptance criteria

- First bullet acceptance criterion for fixture mapping.
- Second bullet acceptance criterion for fixture mapping.
- [ ] Checkbox acceptance criterion remains testable.
- [x] Completed checkbox acceptance criterion is also parsed.

## Verification

1. Run reviewer contract-mapping bullet AC fixtures.

```positive-outcome
asserts: bullet fixture produces candidate ledger entries
input: realistic
```
