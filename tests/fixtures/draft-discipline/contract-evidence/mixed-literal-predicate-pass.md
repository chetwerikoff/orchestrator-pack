# Mixed literal and predicate rows

GitHub Issue: TBD

```contract-evidence
binding-id: ao:reportState:literal
binding: literal row
producer: ao
binding-type: structured
evidence: capture@ao-worker-report/fixing_ci
selector: $.reportState
expected: fixing_ci

binding-id: ao:count:predicate
binding: predicate row
producer: ao
binding-type: structured
evidence: capture@scalar-json/predicate-shapes
selector: $.count
expected: positive-integer
```
