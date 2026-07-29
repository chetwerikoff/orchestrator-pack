# Fixture: required plan with unsupported numbered prose (#1089 shape)

```behavior-kind
action-producing
```

## Goal
Exercise zero-parsed-scenario fail-closed without parser expansion.

```smoke-test-plan
scenarios:
  1. action: run helper | expected: prints ok
  2. action: run gate-check | expected: exits 0
```

## Acceptance criteria
1. Harness refuses before terminal launch.
