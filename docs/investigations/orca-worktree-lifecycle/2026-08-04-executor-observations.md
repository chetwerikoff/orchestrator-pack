# Orca worktree lifecycle investigation — 2026-08-04

Issue: #1298  
Source revision inspected: `66cae1267a66f04a263e767aaaca35c64485239a`

## Result

**Root cause not established.** The available production incident proves a Git/Orca inventory
desynchronization, but it does not prove which lifecycle transition lost or failed to publish the
Orca row.

This executor did not have an installed Orca CLI, `pwsh`, `gh`, or network-capable repository
checkout. Therefore it could not truthfully capture a new installed-version fault injection or
prove that a native adopt/register operation exists. The implementation consequently does not
invent or invoke one. It relies only on command shapes already present in the repository and on the
incident evidence recorded in Issue #1298.

## Observed facts

### Production incident facts from Issue #1298

- Git refused branch deletion because branch `arch/false-blocker-text-fixes` was still checked out
  at `/home/che/orca/workspaces/orchestrator-pack/arch-fb-textfix`.
- `git worktree list --porcelain` reported that path and branch.
- The path existed and had no meaningful tracked changes.
- `orca worktree ps --json` returned no matching path or branch row.
- `orca terminal list --worktree
  path:/home/che/orca/workspaces/orchestrator-pack/arch-fb-textfix --json` returned
  `totalCount: 0`.
- The prior teardown dry-run returned `blocked_state_desync` with
  `validation.is_in_inventory: false` and `validation.path_exists: true` before any destructive
  operation.
- PR #1286 was already merged as `81c1c7d0fd73ad4fdc262922654a6a471a894242`;
  its head was `33d261c081edf09b6e5e0705355d23738a2f2a50`.

### Repository-path facts observed on `main`

- `scripts/worktree-teardown.ts` reads Orca `worktree list`, then returns
  `blocked_state_desync` immediately when the target path does not match exactly one row. The
  existing G1–G5 identity, cleanliness, merge, ownership, and agent checks are not reached in the
  zero-row incident shape.
- The same teardown already owns terminal stop/close, CWD-and-ancestry-bounded process selection,
  a fresh pre-removal recheck, non-force runtime worktree removal, and branch `-d`.
- `scripts/worktree-teardown-runtime-profile.ts` uses supported Orca command shapes:
  `worktree list --json`, `worktree ps --json`, `terminal list --json`, terminal stop/close, and
  non-force `worktree rm`.
- `.claude/skills/direct-fix-checklist/SKILL.md` creates a worktree and then creates a terminal, but
  had no exact dual Git/Orca read-back between those effects.
- `.claude/skills/merge-with-local-adoption/SKILL.md` already states that a cleanup block must not
  invalidate a successful merge, but its canonical command returned non-zero for every blocked
  teardown outcome.

## Surviving hypotheses

Ranked only by proximity to the observed boundary; none is proven.

1. **Git registration completed before Orca registration/persistence became visible.**
   - Supports: exact Git row plus zero Orca row.
   - Refutes/settles: a capture showing Orca emitted a successful durable registration before the
     row disappeared.
2. **An Orca row was created and later archived, removed, or lost.**
   - Supports: a prior successful create receipt or persisted history for the exact identity.
   - Refutes/settles: creation-side capture proving no Orca-visible row ever appeared.
3. **The row exists under a different normalized identity.**
   - Supports: a global Orca list row matching repository/head/branch but not canonical path.
   - Refutes/settles: a complete global inventory with no identity collision.
4. **Create/delete was interrupted between Git and Orca effects or receipts.**
   - Supports: fault-injection reproducing the same partial state.
   - Refutes/settles: atomic upstream lifecycle evidence covering both registries.
5. **Branch reuse, detached transition, path canonicalization, or concurrent activity made the
   original row ineligible.**
   - Supports: conflicting current rows or an identity transition log.
   - Refutes/settles: stable exact identity captures before and after the incident.
6. **Another creation/persistence/lookup interaction.**
   - Remains open until one of the preceding paths is capture-proven.

## Implementation consequence

Because no native adopt/register operation was capture-proven, the implementation treats it as
unsupported. It adds:

- a validated dual census and exact classification;
- mandatory post-create read-back before terminal spawn;
- an explicit dry-run-first Git-only recovery that reuses all applicable safety proofs and permits
  only non-force Git worktree removal;
- nonblocking `cleanup_deferred`/task-level degraded results for unsafe or ambiguous targets;
- post-effect dual read-back and idempotent already-absent behavior.

A future Orca version may add an adoption command only after a production capture proves its exact
arguments, response shape, identity preservation, and read-back. Unsupported output remains a
non-destructive conflict, not permission to guess.

## Required live follow-up on the operator host

Before enabling any future native-adopt branch, capture and check in a follow-up artifact containing:

1. exact `orca --version` output;
2. `orca worktree create/list/ps`, terminal list, remove, and any documented set/adopt help and JSON
   output for a disposable worktree;
3. `git worktree list --porcelain` before and after every boundary;
4. interruption after Git registration and before Orca-visible read-back;
5. interruption after an Orca success response and before caller receipt;
6. interrupted delete and repeated invocation behavior.

Until that capture exists, the supported behavior is guarded non-force Git-only recovery or
preserved/deferred cleanup, never private-state editing, force removal, or filesystem deletion.
