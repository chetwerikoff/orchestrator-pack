# Orca worktree lifecycle investigation — 2026-08-04

Issue: #1298  
Initial source revision inspected: `66cae1267a66f04a263e767aaaca35c64485239a`

## Result

**Root cause not established.** The available production incident proves a Git/Orca inventory
desynchronization, but it does not prove which lifecycle transition lost or failed to publish the
Orca row.

This executor did not have an installed Orca CLI or a network-capable local repository checkout.
Therefore it could not truthfully capture a new installed-version fault injection or prove that a
native adopt/register operation exists. The implementation consequently does not invent or invoke
one. It relies on command shapes already present in the repository, the incident evidence recorded
in Issue #1298, and hermetic command-runner regressions for the pack-owned decision boundaries.

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
- Before Issue #1298, `.claude/skills/direct-fix-checklist/SKILL.md` created a worktree and then a
  terminal without one mechanical exact-dual Git/Orca gate owning create and replacement.
- `.claude/skills/merge-with-local-adoption/SKILL.md` already stated that a cleanup block must not
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
   - Supports: fault injection reproducing the same partial state.
   - Refutes/settles: atomic upstream lifecycle evidence covering both registries.
5. **Branch reuse, detached transition, path canonicalization, or concurrent activity made the
   original row ineligible.**
   - Supports: conflicting current rows or an identity transition log.
   - Refutes/settles: stable exact identity captures before and after the incident.
6. **Another creation/persistence/lookup interaction.**
   - Remains open until one of the preceding paths is capture-proven.

## Implemented pack-owned boundary

The implementation now contains one executable bounded create/continuation actuator in
`scripts/worktree-lifecycle/create-continuation.ts`. It:

- acquires the same process-local exclusion path used by recovery/teardown;
- reads Git and Orca before create;
- resumes one already exact-dual Issue-bound target without another create;
- otherwise performs one primary create attempt and always reads both authorities back, including
  after timeout or missing receipt;
- preserves disputed state and performs at most one isolated replacement create;
- roots both attempts at the exact intended full source SHA;
- performs two fresh exact-dual reads before returning one terminal-spawn-authorized path;
- returns task-level degraded control without a third create when the bound cannot be satisfied.

The classifier was corrected so a shared source commit alone is not an identity collision. This is
necessary because the required replacement intentionally starts from the same source SHA. Path,
branch, Issue/PR binding, mode, and the complete validated row remain collision authorities.

Guarded PR-bound recovery additionally verifies the live merged PR head and branch before lifecycle
evaluation and again immediately before worktree removal, branch deletion, or standard teardown.
Caller-supplied expected identity alone is not destructive authority.

## Executable regression evidence

Hermetic production-shaped command-runner tests cover:

- one initial create plus at most one replacement;
- effect-before-receipt create timeout with authoritative read-back and no blind retry;
- rerun after a completed exact-dual create without another create;
- disputed pre-existing state selecting replacement only;
- ABA path reuse rejection;
- concurrent create callers with one exclusion winner and one no-effect loser;
- dead-owner lock recovery and live-owner fail-closed behavior;
- interrupted removal where the effect completed before receipt loss, followed by idempotent
  already-absent settlement;
- partial Git/Orca disappearance without repeated removal;
- branch reuse and non-allowlisted ignored-data preservation.

These tests establish the pack-owned decision behavior. They do not substitute for the missing
installed-Orca production capture required by AC #1.

## Native-adopt disposition

Because no native adopt/register operation was capture-proven, the implementation treats it as
unsupported. Exact Git-only recovery permits only Git's non-force registered-worktree removal after
all gates pass. Unsupported or malformed output remains a non-destructive conflict, not permission
to guess, edit private Orca persistence, force-remove, or delete a filesystem path.

## Required live follow-up on the operator host

Before Issue #1298 can satisfy AC #1, and before enabling any future native-adopt branch, capture a
follow-up artifact containing:

1. exact `orca --version` output;
2. `orca worktree create/list/ps`, terminal list, remove, and any documented set/adopt help and JSON
   output for a disposable worktree;
3. `git worktree list --porcelain` before and after every boundary;
4. interruption after Git registration and before Orca-visible read-back;
5. interruption after an Orca success response and before caller receipt;
6. interrupted delete and repeated invocation behavior;
7. caller/scheduler evidence that one degraded task returns control without stopping unrelated
   work.

Until that capture exists, the supported behavior is bounded replacement, guarded non-force
Git-only recovery, or preserved/deferred cleanup. No native adopt/register path is authorized.
