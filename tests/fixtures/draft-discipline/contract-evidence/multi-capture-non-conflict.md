# Multi-capture non-conflict

GitHub Issue: TBD

```contract-evidence
binding-id: ao:reportState:fixing_ci_live
binding: fixing_ci capture
producer: ao
binding-type: structured
evidence: capture@ao-worker-report/fixing_ci
selector: $.reportState
expected: fixing_ci

binding-id: ao:reportState:working_live
binding: working capture
producer: ao
binding-type: structured
evidence: capture@ao-worker-report/wrong_value
selector: $.reportState
expected: working
```
