# CLI behavior structured reserved token must stay literal

GitHub Issue: TBD

```contract-evidence
binding-id: ao:command:report-json
binding: JSON-producing CLI command
producer: ao
binding-type: cli-behavior
evidence: capture@cli-behavior/json-success
exit-status: 0
selector: $.accepted
expected: boolean
```
