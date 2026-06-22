# Reverify fixture: unsupported producer

GitHub Issue: #9011

## Goal

Unsupported producer with no capture.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: unknown:datum:value
binding: unsupported producer row
producer: unknown-producer
binding-type: structured
evidence: capture@producer/unsupported
selector: $
expected: match
```

## Acceptance criteria

1. Unsupported producer is unverified.
