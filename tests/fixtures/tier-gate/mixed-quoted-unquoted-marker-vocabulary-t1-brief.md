# Mixed marker vocabulary T1 brief

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
asserts: mixed quoted and unquoted marker examples fail below T3
input: realistic
```

## Goal

Document the quoted phrase `required checks`, then operate on branch protection for merge.

## Denylist

```denylist
vendor/**
packages/core/**
```

```allowed-roots
scripts/lib/tier-marker-screen.ts
```

## Acceptance criteria

1. The unquoted marker still fails.

## Verification

1. Run the tier-gate guard.
