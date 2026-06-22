# Reverify fixture: live cli-behavior match

GitHub Issue: #9013

## Goal

Fixture issue for checkpoint-2 live verified cli-behavior capture row.

```behavior-kind
action-producing
```

## Contract evidence

```contract-evidence
binding-id: orchestrator-pack-scripts:command:cli-success
binding: CLI command succeeds with expected JSON stdout
producer: orchestrator-pack-scripts
binding-type: cli-behavior
evidence: capture@cli-behavior/success
selector: $.ok
expected: true
exit-status: 0
```

## Acceptance criteria

1. Producer still exits 0 and emits ok:true at review time.
