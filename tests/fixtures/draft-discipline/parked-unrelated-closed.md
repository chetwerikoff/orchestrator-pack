# Parked unrelated closed issue

GitHub Issue: TBD

## Goal

Track the binding defect.

```parked-root-cause
cause: AO 0.9.x ao report records no headRefOid so SHA-from-report binding is unsatisfiable
evidence: reconcile defers on SHA-less ready_for_review reports
reason-deferred: separate binding issue
follow-up-issue: #888
resolution-policy: close when binding lands
```

## Denylist

```denylist
vendor/**
```
