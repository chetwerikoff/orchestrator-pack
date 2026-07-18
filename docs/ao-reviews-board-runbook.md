# Historical AO Reviews Board prototype — deprecated

> **Historical / deprecated.** This runbook is preserved only for the former daemon-review
> board prototype and UI tests. The Reviews Board is not a current `orchestrator-pack`
> subsystem and is not a source of truth for pack-owned review.
>
> Use [`pack-review-runbook.md`](pack-review-runbook.md) for current operations.

## Historical scope

The prototype reads AO session-review HTTP data and displays the preserved seven-column
board mapping. Those statuses are historical UI states; they are not the lifecycle model
of the pack review-run store.

AO review HTTP API and `ao review submit` remain available upstream in AO 0.10.3. They are
retired by this pack and must not be used as pack-review invocation, status, delivery,
fallback, dual-write, or merge-authority paths.

## Prototype-only launch

For historical UI or compatibility testing only:

```bash
cd /path/to/orchestrator-pack
AO_DAEMON_URL=http://127.0.0.1:3001 AO_REVIEWS_BOARD_PORT=4310 \
  node --import tsx tests/ao-reviews-board-runtime/start.ts
```

An empty or stale board is expected when only pack-owned review is active. It is not
evidence that no review exists.

The existing prototype regression check verifies only the retained historical UI:

```powershell
pwsh -NoProfile -File tests/ao-reviews-board-runtime/check.ps1
```

## Current review evidence

Use the pack-owned store and GitHub:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list \
  --project-id orchestrator-pack
```

Then bind evidence to the current GitHub head, inspect the human-visible COMMENT, verify
exact-head status `orchestrator-pack/pack-review`, and check required repository CI.

## Scope boundary

This document change does not remove the Reviews Board runtime or tests. Physical removal
or re-basing the board on the pack store requires a separate issue.
