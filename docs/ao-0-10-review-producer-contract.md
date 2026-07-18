# Historical AO review producer contract — deprecated

> **Historical / deprecated.** This document belongs to the former AO daemon-review and
> Reviews Board prototype. It is not the producer contract for current pack-owned review,
> is not a source of truth, and must not be used for invocation, status, delivery, binding,
> or merge decisions.

The complete current contract is
[`pack-review-runbook.md`](pack-review-runbook.md).

## Historical scope

This document name is retained so old links continue to resolve while the prototype code
and tests remain in the repository. The prototype consumed AO session-review HTTP rows and
mapped them into the legacy Reviews Board model. Its producer state and seven board
statuses do not describe the current pack review-run store.

AO review HTTP API and `ao review submit` remain available upstream in AO 0.10.3. They are
retired by `orchestrator-pack`; they are not removed upstream and are not fallback or
dual-write paths.

## Current evidence

Use the following instead:

- the pack review-run store, listed through `scripts/pack-review-runner.ts list`;
- the current-head GitHub COMMENT for human presentation;
- exact-head status `orchestrator-pack/pack-review` for pack review merge authority;
- required repository CI and current GitHub PR/head state.

Physical removal of the Reviews Board runtime, old producer adapters, and their tests is a
separate cleanup task outside issue #898.
