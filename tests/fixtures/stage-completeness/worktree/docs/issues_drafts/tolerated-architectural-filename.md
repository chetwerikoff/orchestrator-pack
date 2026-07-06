# T3 stage-completeness fixture

GitHub Issue: TBD

```complexity-tier
tier: T3
advisory-prior: T2
```

```behavior-kind
action-producing
```

```contract-evidence
none
```

## Goal

Fixture draft for stage-completeness guard tests.

## Denylist

```denylist
vendor/**
```

```allowed-roots
scripts/**
tests/**
```

## Acceptance criteria

1. Guard behavior is covered by vitest fixtures.

## Verification

1. `npx vitest run -t "stage-completeness"`
