# CI gating change marked T1

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

## Goal

Change which CI jobs are fail-closed required checks for merge (branch protection contract).

## Denylist

```denylist
vendor/**
packages/core/**
```

```allowed-roots
.github/**
scripts/**
```

## Acceptance criteria

1. Required checks updated.

```positive-outcome
asserts: merge is blocked when a required check is red
input: realistic
```

## Verification

1. CI fixture proves refusal.
