# Historical AO review-harness adoption note

> **Historical / compatibility note.** Earlier pack versions used or discussed AO
> reviewer-harness and daemon-review surfaces. AO review HTTP API, `ao review submit`,
> and project reviewer configuration remain available upstream in AO 0.10.3, but they
> are retired by `orchestrator-pack`.

Current review starts through `scripts/pack-review-runner.ts`, uses
`scripts/invoke-pack-review.ps1`, and is selected by `PACK_REVIEWER`. AO Reviews are not
invocation, status, delivery, fallback, dual-write, binding, or merge-authority paths.

The complete current contract and adoption procedure is
[`pack-review-runbook.md`](pack-review-runbook.md). Do not copy commands or lifecycle
rules from this historical file into live configuration.

Physical removal of remaining AO compatibility adapters is a separate cleanup task.
