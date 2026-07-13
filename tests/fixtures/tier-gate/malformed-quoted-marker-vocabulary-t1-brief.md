# Malformed quoted marker vocabulary T1 brief

GitHub Issue: TBD

```complexity-tier
tier: T1
advisory-prior: T1
```

```behavior-kind
action-producing
```

```contract-evidence
none
```

```positive-outcome
asserts: malformed quoted marker examples fail below T3
input: realistic
```

## Goal

Discuss the unterminated example "required checks without closing it.

## Denylist

```denylist
vendor/**
packages/core/**
```

```allowed-roots
scripts/lib/tier-marker-screen.ts
```

## Acceptance criteria

1. Malformed quotation does not exempt the marker.

## Verification

1. Run the tier-gate guard.
