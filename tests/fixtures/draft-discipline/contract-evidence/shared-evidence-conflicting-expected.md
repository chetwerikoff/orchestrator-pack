# Conflicting assertions on shared capture evidence

GitHub Issue: TBD

```contract-evidence
binding-id: ao:reportState:fixing_ci
binding: first assertion
producer: ao
binding-type: structured
evidence: capture@ao-worker-report/fixing_ci
selector: $.reportState
expected: fixing_ci

binding-id: ao:reportState:fixing_ci
binding: conflicting assertion
producer: ao
binding-type: structured
evidence: capture@ao-worker-report/fixing_ci
selector: $.reportState
expected: working
```
