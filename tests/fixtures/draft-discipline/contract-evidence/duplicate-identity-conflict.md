# Conflicting duplicate binding identity

GitHub Issue: TBD

```contract-evidence
binding-id: ao:reportState:fixing_ci
binding: first row
producer: ao
evidence: capture@ao-worker-report/fixing_ci
selector: $.reportState
expected: fixing_ci

binding-id: ao:reportState:fixing_ci
binding: second row with different evidence
producer: ao
evidence: capture@ao-worker-report/wrong_value
selector: reportState
expected: working
```
