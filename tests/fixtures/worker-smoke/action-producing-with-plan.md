# Fixture: action-producing task with smoke scenarios

```behavior-kind
action-producing
```

## Goal
Add a helper with operator-visible behavior.

```smoke-test-plan
scenarios:
  - action: run `worker-smoke-run validate-plan --issue-body-file issue.md` | expected: exits 0
  - action: invoke the new helper against fixture input | expected: prints structured PASS payload
```

## Acceptance criteria
1. Helper works.
