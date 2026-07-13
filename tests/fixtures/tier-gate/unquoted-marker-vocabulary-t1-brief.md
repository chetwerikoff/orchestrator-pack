# Unquoted marker vocabulary T1 brief

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
asserts: unquoted marker examples fail below T3
input: realistic
```

## Goal

Operate on required checks and branch protection for merge authorization.

## Denylist

```denylist
vendor/**
packages/core/**
```

```allowed-roots
scripts/lib/tier-marker-screen.ts
```

## Acceptance criteria

1. The genuine marker remains protected.

## Verification

1. Run the tier-gate guard.
