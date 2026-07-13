# Quoted marker vocabulary T1 brief

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
asserts: quoted marker examples are ignored while unquoted markers still fail
input: realistic
```

## Goal

Document the marker screen's quotation handling without editing marker classes.

## Examples

Inline code span: `required checks`

Fenced code block:

```text
branch protection
```

Rubric row:

> T3 | ci-review-gating | merge authorization

Quoted regex pattern: "\brequired\s+checks?\b"

Quoted test-fixture string: 'Change external API timeout semantics for the REST wrapper.'

## Denylist

```denylist
vendor/**
packages/core/**
```

```allowed-roots
scripts/lib/tier-marker-screen.ts
```

## Acceptance criteria

1. Quoted examples do not determine the tier.

## Verification

1. Run the tier-gate guard.
