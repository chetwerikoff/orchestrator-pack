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

## First-time supervisor activation (Issue #1422)

### What changed

First activation now uses the existing `orchestrator-cutover-activate.ts`
transaction when the request has no claimed legacy PID (`legacySupervisorPid`
omitted or `0`). Before the cordon is written, the transaction observes all of
the following: an empty epoch authority, no live registered TypeScript
supervisor or `pr2-scheduler` child, no live legacy supervisor or registered
legacy writer, and a roster containing only the local host. Any competing or
unobservable state fails closed without committing an epoch.

The required `foundation-923-adoption.json` is produced by the tracked
TypeScript command; it must not be hand-written:

```bash
node --experimental-strip-types scripts/cutover/foundation-adoption-producer.ts \
  --repo-root "$PWD" \
  --state-dir "$HOME/.local/state/orchestrator-pack-wake-supervisor"
node --experimental-strip-types scripts/orchestrator-cutover-activate.ts \
  activate <greenfield-activation-request.json>
```

Before running the producer, the canonical state root must contain
`foundation-config.json`, `app-state.json`, `host-roster.json`, and at least one
committed migration journal. The producer observes these files and the live
runtime; it rejects alternate paths and caller-supplied journal rosters.
The request must bind `expectedOldEpochId: null`, the locally observed
single-host roster, the emitted evidence path, and the existing three cutover stores. A request
with a claimed legacy PID still takes the identity, aliveness, old-revision
ownership, writer capture, drain, and termination path. No flag or environment
variable bypasses `proveFoundationAdoption`.

### Rollback

Before the import boundary, use `prove-rollback` and then
`rollback-preimport` with the same request. After the import boundary, use
`recover`; the existing forward-only recovery and epoch CAS remain authoritative.
Do not delete or hand-edit the evidence, cordon, epoch, or follow-up artifacts.

## Bounded-child S1/S2 supervision (Issue #1420)

### What changed

Issue #1420 makes the existing `pr2-scheduler` cadence production-capable across
separate bounded `scheduler.ts tick` child processes without adding another daemon
or scheduler. S1 continuity is restored only from the existing atomic S1 snapshot
when the current activation lineage, current WorkerAssignment generation, and exact
RuntimeAdapter-resolved worker still agree. Routine continuation remains the
existing S2 one-shot path.

A successful supervised local start must go through the PACK
`scripts/pr2-foundation/supervised-worker-start.ts` boundary so the proven Orca
Dispatch publishes the current local WorkerAssignment. The persistence-safe binding
is the Orca `dispatchId`; raw RuntimeWorkerIdentity, terminal handles/generations,
output and observation tokens are not persisted in assignment or S1 state.

Cases that cannot be safely resolved remain fail-closed. `dispatch_unknown` is not
retried through another transport, and `orchestrator_required` is published only
through the bounded atomic `fleet-reconciliation-handoff/v1` latest-state artifact.

### Operator adoption

1. Merge and pull the #1420 pack revision into the operator checkout that owns the
   existing TypeScript side-process supervisor. Do not change the registered
   `pr2-scheduler` child shape or add a parallel scheduler/watchdog.
2. Use the existing supported pack adoption/recycle path so the supervisor and new
   bounded children load the merged `AGENTS.md`, runtime adapter contract, assignment
   store, scheduler and runbook. Do not hand-edit generated runtime state.
3. Start new supervised local manager/worker attempts through
   `scripts/pr2-foundation/supervised-worker-start.ts`; a failed or unknown Orca
   startup must not be treated as a current successful assignment.
4. Read back one successful current local assignment and verify that its durable
   binding contains the logical assignment generation and Orca `dispatchId`, not a
   raw runtime id/generation or terminal title/path/PID.
5. Observe a supervisor-owned `scheduler.ts tick` under the current activation
   epoch, then observe a later bounded child under the same epoch. Confirm that the
   accepted S1 `schedulerGeneration` is unchanged while `tickSequence` advances.
6. For an eligible supervised idle/livelock case with an exact current assignment,
   verify one S2 attempt settles through the existing claim/gate/journal path and a
   later child does not recreate the same episode. Do not infer success from worker
   prose alone.
7. Verify at least one fail-closed case: stale/missing assignment, runtime mismatch,
   remote assignment, lineage reset, or `dispatch_unknown` must produce no alternate
   send/retry.
8. Read the latest `fleet-reconciliation-handoff/v1` artifact before treating
   supervision silence as healthy. If a required handoff cannot be committed and
   read back, the scheduler child must surface non-success through the existing
   supervisor status rather than silently succeeding.

Repository merge alone is not evidence that the operator machine is active on the
new supervision contract. Do not claim live adoption until steps 1-8 are observed
against the current deployed activation epoch.

### Rollback

Rollback is a source-control revert to the prior pack revision followed by the
normal supported pack adoption/recycle path. Do not preserve a partially adopted
#1420 assignment/S1/S2 path by adding compatibility aliases, heuristic target
resolution, dual-send, a fallback runtime selector, or a second scheduler/store.
Previously written bounded state is evidence only and never authorizes an effect
when it no longer matches the active code/epoch/assignment contract.

## Ongoing adoption rule

Keep this file limited to currently actionable operator changes. Historical
procedures remain available in Git history but must not be copied back into active
runbooks when they prescribe removed commands, configuration, state, packages, or
transport.
