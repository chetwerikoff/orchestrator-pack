# Script-owned pack review pipeline

The complete current contract is [`pack-review-runbook.md`](pack-review-runbook.md).

This document is only an implementation map for maintainers. It is not a second operator
runbook and does not define independent trigger, delivery, retry, binding, reviewer-switch,
or merge semantics.

## Live pack-owned entrypoints

- `scripts/pack-review-runner.ts` owns manual and automatic review starts.
- `scripts/invoke-pack-review.ps1` is the reviewer wrapper boundary.
- `scripts/lib/pack-review-run-store.ts` owns the durable run record.
- `docs/pr-session-binding-cache.mjs` owns durable PR ↔ session binding support.
- `scripts/review-trigger-reconcile.ps1`, deferred re-evaluation, and report-state seed may
  propose starts, but all converge on the same runner and shared claim.

Live pack review must not invoke `ao review run`, use AO review HTTP as a status source,
dual-write through `ao review submit`, or treat daemon review rows as merge authority.
AO review surfaces still exist upstream in AO 0.10.3; they are retired by this pack.

## Runtime invariants

Maintainer checks may enforce executable invariants such as:

- the pack runner, store, and wrapper exist;
- the runner publishes exact-head status `orchestrator-pack/pack-review`;
- no live pack path calls the daemon review trigger or a retired entrypoint;
- delivery channels remain independent;
- the runner does not call `ao review run`.

Do not enforce the correctness of this or another Markdown document through required
phrases, section names, script-name inventories, or source regex that merely checks prose.

## Compatibility names

`Get-AoReviewRuns` is a compatibility reader name for the pack store. It must not fan out
to AO review state. Other compatibility surfaces are described, with their limitations,
in the canonical runbook.
