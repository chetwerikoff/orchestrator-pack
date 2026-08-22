# Wake-supervisor fleet operator reference

Living operator reference for the TypeScript registry-backed fleet. The
supervisor roster is defined only by
`scripts/orchestrator-side-process-registry.json`.

## Supervisor entry point

```bash
cd <orchestrator-pack-root>
node --experimental-strip-types scripts/orchestrator-wake-supervisor.ts run \
  --state-dir <state-dir> \
  --repo-root <orchestrator-pack-root> \
  --epoch-authority <state-dir>/epoch-authority.json \
  --epoch-id <epoch-id> \
  --nonce <epoch-nonce> \
  --target-registry scripts/orchestrator-side-process-registry.json \
  --projected-registry <state-dir>/projected-registry.json \
  --detach
node --experimental-strip-types scripts/orchestrator-wake-supervisor.ts status \
  --state-dir <state-dir>
```

Default Linux state root: `$XDG_STATE_HOME/orchestrator-pack-wake-supervisor/`
or `~/.local/state/orchestrator-pack-wake-supervisor/`.

For a machine with no prior activation, first produce observed foundation
evidence and then invoke the existing activation transaction:

```bash
node --experimental-strip-types scripts/cutover/foundation-adoption-producer.ts \
  --repo-root <orchestrator-pack-root> \
  --state-dir <state-dir>
node --experimental-strip-types scripts/orchestrator-cutover-activate.ts \
  activate <greenfield-activation-request.json>
```

For greenfield activation, the machine-canonical state root must not contain
`foundation-config.json`, `app-state.json`, or a committed migration journal.
Recognizable migration journals are canonicalized under
`migration-journals/*.migration-journal.json`; prepared, imported, committed, or
corrupt records there refuse greenfield admission.
The producer records their observed absence together with the empty epoch
authority, registered-child census, legacy-writer census, and live repository.
Its greenfield evidence includes readiness observed through the registered
runtime adapter and emits no dormant-layer defaults or app-state version claim.
Its heartbeat is timestamped by the live observation performed during
production, not by a repository source-file mtime. A partially present set is
ambiguous and fails closed. A complete artifact set continues through the existing
artifact-backed foundation proof. Alternate config, app-state, state, or journal
paths are rejected. `OPK_WAKE_SUPERVISOR_STATE_DIR` is rejected during activation
and evidence production, so it cannot redirect proof to another root.
The greenfield request has no claimed legacy supervisor PID (omit the field or
use `0`) and must bind the locally observed host as its single-host expectation.
This is a local-only greenfield contract; the writable state tree is not an
independent global fleet-membership authority. If a legacy PID is claimed, or
if absence cannot be observed, the transaction requires the legacy-handover
proof and fails closed when that proof is missing.

## Registry roster

| `children[].id` | Script | Cadence (s) | Responsibility |
| --- | --- | ---: | --- |
| `pr2-scheduler` | `pr2-foundation/scheduler.ts` | 5 | Bounded fleet supervision, review-start scheduling, and unsent Cursor poke submit |

### pr2-scheduler

Runs one bounded `scheduler.ts tick` child at a time under the committed
activation epoch. It owns the existing S1/S2 supervision and review-start
phases, and after that tick it submits an exact stable Orca poke left unsent in
a headed Cursor composer. It is not a second scheduler, registry child, or
composer daemon. Quiet/fingerprint state persists so a restarted tick does not
lose the 10-second window or resend.
The child derives the canonical repository slug from the `origin` remote under
its checked-out repository root; it does not require `OPK_REPOSITORY` or
`GITHUB_REPOSITORY`. Its observer census is scoped to that exact worktree,
rather than the process owner's unrelated active-worktree selector.

## Liveness model

- The supervisor starts only the registered `pr2-scheduler` child.
- Child restart preserves the activation lineage and remains bounded by the
  supervisor's existing restart policy.
- The scheduler must pass the epoch authority and nonce check before any tick.
- No listener, webhook child, or alternate supervisor is part of the fleet.

## Verification

The authoritative fleet check is:

```bash
node --experimental-strip-types scripts/orchestrator-wake-supervisor.ts status \
  --state-dir <state-dir>
```

A healthy status reports one `pr2-scheduler` registry child. Any other child
identity or a deleted PowerShell entrypoint is configuration drift.

## Recovery scenarios

### F1 — normal operation

The supervisor owns one bounded `pr2-scheduler` child at a time. The child
performs one epoch-gated tick and exits; the supervisor starts the next child
according to the registered five-second cadence.

### F2 — child crash or stall

The supervisor restarts the affected registry child using the existing crash-backoff and
side-effect-lock contracts. That restart is also how a failed unsent-composer
submit inside the tick is raised again. It must never revive a retired entrypoint
or add a second composer process.

## Operator adoption

After a registry-changing deployment, use the supported activation/recovery
transaction, then verify the current epoch, supervisor status, and one-child
roster. See [`migration_notes.md`](migration_notes.md) for first-time
activation and Issue #1420 adoption.

## When to update this document

Update this reference whenever the registry adds, removes, renames, or changes the responsibility
or cadence of a supervised child. The table, per-child headings, liveness model, and recovery
scenarios must remain aligned with `scripts/orchestrator-side-process-registry.json`.
