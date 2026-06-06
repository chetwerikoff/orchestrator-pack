# Dual deferral — one block plus prose deferral

GitHub Issue: TBD

## Goal

Ship the listener while tracking defects separately.

```parked-root-cause
cause: AO 0.9.x ao report records no headRefOid so SHA-from-report binding is unsatisfiable
evidence: ao review list shows ready_for_review reports without headRefOid while reconcile defers
reason-deferred: binding repair is owned by issue #218 and must not block listener supervision
follow-up-issue: #218
resolution-policy: close when head-ready binding no longer depends on report-stored SHA
```

We defer the suspected root cause of listener race retries to a future task.

## Denylist

```denylist
vendor/**
```
