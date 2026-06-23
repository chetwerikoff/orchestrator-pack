# Reverify fixture: external compared-to-record

GitHub Issue: #9007

## Goal

Non-reproducible external producer uses compared-to-record.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: gh:pr:number
binding: gh pr list number field
producer: gh
binding-type: structured
evidence: capture@external/gh-open
selector: $
expected: match
```

## Acceptance criteria

1. Integrity-checked only at review time.
