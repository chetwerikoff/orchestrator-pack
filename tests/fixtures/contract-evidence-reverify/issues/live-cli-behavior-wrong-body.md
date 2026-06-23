# Reverify fixture: live cli-behavior wrong stdout

GitHub Issue: #9014

## Goal

Fixture issue for cli-behavior row where exit matches but stdout diverges.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:command:cli-success
binding: CLI command exit ok but JSON stdout diverges
producer: orchestrator-pack-scripts
binding-type: cli-behavior
evidence: capture@cli-behavior/wrong-body
selector: $.ok
expected: true
exit-status: 0
```

## Acceptance criteria

1. Divergence surfaces exit match with stdout mismatch.
