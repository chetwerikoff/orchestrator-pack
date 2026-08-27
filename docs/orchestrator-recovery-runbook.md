# Orchestrator recovery runbook

Manual recovery for pack-owned supervisor, review, CI, and worker coordination.
This runbook does not restore a removed command, API, configuration file, state
root, compatibility alias, or fallback transport.

Recovery is read-only until an explicitly authorized lifecycle action. Silence,
missing telemetry, an old process ID, or a stale store row is not proof that a
session or child is dead.

## Start with exact evidence

Record:

- repository, branch, and current commit;
- PR number and exact head SHA;
- required-check state for that head;
- pack review run and claim state;
- supervisor roster and child health;
- exact runtime adapter identity when a runtime-bound action is involved;
- relevant stderr/stdout and timestamps.

Useful read-only checks:

```bash
node --experimental-strip-types scripts/orchestrator-wake-supervisor.ts status --state-dir <state-dir>
node --experimental-strip-types scripts/pack-review-runner.ts list --pr-number <PR_NUMBER>
node --experimental-strip-types scripts/pack-review-runner.ts status --pr-number <PR_NUMBER>
```

Use GitHub as the authority for PR body, linked Issue, head SHA, reviews, and CI.
Use the pack store only for operational state.

## Classify the failure

| Class | Evidence | First response |
|---|---|---|
| GitHub or CI transport failure | request or runner error before product code | retry the same read or job through the governed transport; preserve the error |
| Required CI red | failed merge-contract check on current head | keep worker in `fixing_ci`; inspect and fix the failing check |
| Review computation failed | timeout, malformed, empty, contradictory, cancelled, or non-zero result | keep non-clean; inspect exact reviewer evidence; do not resend blindly |
| Review delivery pending | terminal findings exist but publication is not confirmed | let the single publication owner reconcile; do not create a second sender |
| Supervisor child unhealthy | identity-bound child has explicit failed/stalled evidence | isolate the child, inspect state and command line, then restart under supervisor policy |
| Runtime identity unresolved | missing, stale, reused, or mismatched `{ runtime, id, generation }` | perform no effect; refresh through the registered adapter |
| Worker idle with obligations | open findings, red CI, pending smoke, or incomplete handoff on current head | resume the worker through its owned workflow; do not declare completion |
| Legitimately idle | no active obligation and no pending current-head work | take no recovery action |

## Required CI recovery

1. Confirm the PR body links exactly one implementation Issue with `Closes #N`,
   `Fixes #N`, or `Resolves #N`.
2. Confirm the check belongs to the current head.
3. Separate infrastructure failure from product failure.
4. For product failure, fix the narrowest durable contract and push a new head.
5. Re-run required checks on the new head.
6. Keep the worker engaged until CI, review, smoke, and handoff all complete.

A previous-head pass or a missing check does not satisfy the current head.

## Review recovery

The pack review runner owns start, list, status, claims, duplicate suppression, and
cycle caps. A failed or empty run is not clean.

- Do not start another review while an active same-head claim or run exists.
- Do not reuse a clean result after the PR head changes.
- Do not bypass the runner by invoking one reviewer plugin as an independent path.
- Do not treat an operator URL, comment receipt, or partial transport success as
  authoritative publication.
- Repeated same-class failure follows the caller-owned cap and escalation policy;
  it does not become success.

Manual Browser-GPT review, when explicitly required, uses:

```bash
npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>
```

## Supervisor recovery

The supervisor must report the exact roster in
`scripts/orchestrator-side-process-registry.json`. The retired listener, heartbeat,
worktree-trust watcher, legacy review sender, and removed fleet children must not
appear.

1. Read status and child evidence.
2. Confirm a child is actually failed or stalled using its documented heartbeat,
   progress, process identity, and generation.
3. Stop the supervisor only when a fleet-level restart is justified.
4. Terminate only identity-matched orphan processes.
5. Restart from the exact intended checkout.
6. Read back the roster and observe one normal cadence.

Never kill by port or PID alone. Never delete an arbitrary worktree or state
location as a generic recovery step.

## Runtime-bound recovery

Runtime effects go through `RuntimeAdapter`. Resolve an exact adapter-produced
identity:

```text
{ runtime, id, generation }
```

Missing, malformed, stale, reused, or conflicting identity yields a typed non-effect
outcome. A session-like string, branch, path, display name, process ID, or accounting
row is insufficient.

A direct operator instruction may authorize a specific lifecycle action, but the
read-back must still report the actual target, outcome, and any failed check.

## Worker recovery

For a worker with current-head obligations:

1. bind the worker to repository, PR, head, and exact runtime identity when needed;
2. inspect open review findings, required CI, smoke, and report state;
3. resume the existing owned workflow when safe;
4. use the tracked recovery spawn only when the existing worker is explicitly
   terminal or unrecoverable and the caller owns that decision;
5. preserve retry and cycle caps;
6. require current-head handoff after recovery.

No-crash silence is not death. An ambiguous owner or reused identifier fails closed.

## Scope-guard recovery

A scope failure is fixed by correcting the Issue, generated declaration, or diff.
Do not broaden scope simply to make CI pass. The denylist remains stronger than a
broad allow glob. Generated declarations are not hand-edited.

For GitHub-read failure on a fork, only the documented degraded mode with an
authorized label may proceed; otherwise fail closed.

## Host cleanup boundary

Removing obsolete host software, configuration, caches, or state is optional
post-merge operator work. It is not repository recovery, acceptance, or rollback.
Do not reintroduce a removed route to recover a task.

## Completion evidence

Recovery is complete only when all applicable evidence is current and consistent:

- exact intended checkout and PR head;
- healthy required supervisor children;
- no retired process or route;
- required CI green on the current head;
- terminal review state on the current head;
- findings addressed or explicitly dispositioned;
- smoke passed on the current head;
- durable worker handoff recorded when binding can be proved;
- no unresolved runtime identity or hidden fallback.

Document any operator adoption in `docs/migration_notes.md` and the PR body. Merge
only under direct operator authority.
