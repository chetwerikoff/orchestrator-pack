# Migration notes

## Runtime-neutral hard cut (Issue #1352)

### What changed

The repository no longer carries an active dependency on the removed orchestration
platform. Executable commands, daemon and HTTP clients, configuration and state
roots, environment authority, review transport, runtime-specific helper symbols,
operator setup prescriptions, and old plugin identities were removed rather than
aliased.

Current behavior is owned by these tracked authorities:

- `RuntimeAdapter` and the runtime registry for terminal and worker operations;
- Orca as the currently registered concrete adapter;
- `scripts/pack-review-runner.ts`, the pack review store, and the review claim
  authority for review start, list, and status;
- `scripts/lib/operator-publication.ts` for bounded zero-or-one operator
  publication;
- `scripts/lib/worker-degraded-ci-handoff.ts` for exact-composite degraded-CI
  handoff;
- runtime-neutral declaration, scope, accounting, and Codex review plugins;
- `scripts/runtime-retirement/retired-surface-guard.ts` as the single active
  scanner for removed surfaces.

No compatibility alias, dual execution, fallback transport, state conversion,
drain wait, or rollback execution path was introduced.

### Operator adoption

1. Pull the merged pack into each checkout or managed session that must execute the
   updated tracked policy and scripts.
2. Use Node.js 22.x and install the frozen workspace dependencies with
   `npm ci --include=dev`.
3. Recycle only affected managed sessions or supervised pack processes so they load
   the new `AGENTS.md`, scripts, plugin paths, and package identities. Do not add a
   removed configuration file or state root to make an old procedure work.
4. Confirm the concrete runtime is registered through
   `scripts/runtime/registry.ts` and that effects receive an adapter-produced
   `{ runtime, id, generation }` identity.
5. Run current-head verification:

   ```bash
   npm run typecheck:foundation
   npm run lint:foundation
   npm run test:foundation
   npm run gate-runner-selftest
   node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
   pwsh -NoProfile -File scripts/verify.ps1
   pwsh -NoProfile -File scripts/check-reusable.ps1
   ```

6. Verify one current-head review through the pack review runner, one exact-composite
   runtime operation through the registered adapter, and the task-specific smoke
   scenarios before declaring the rollout complete.

### Host cleanup boundary

Removal of obsolete host software, user configuration, caches, or state is optional
post-merge operator work. Repository acceptance does not wait for that cleanup, and
old host records never authorize a side effect.

Cleanup must be identity-scoped and performed outside managed worker sessions. Do
not delete arbitrary workspaces, credentials, unrelated state, or audit evidence.

### Rollback

Rollback is a source-control revert of the hard-cut changes followed by the normal
current-head verification for the reverted tree. Do not convert old state, restore a
fallback transport, or reinterpret an old short identifier as runtime authority.
Existing GitHub review, CI, Issue, PR, and audit history remains immutable evidence.

## Ongoing adoption rule

Keep this file limited to currently actionable operator changes. Historical
procedures remain available in Git history but must not be copied back into active
runbooks when they prescribe removed commands, configuration, state, packages, or
transport.
