# Orchestrator and pack-loop recovery runbook

Manual operator procedure for AO 0.10.3 session health, worker recovery, CI stalls,
and pack side-process failures.

Complete pack-review operations and evidence semantics:
[`pack-review-runbook.md`](pack-review-runbook.md).

## Current command surfaces

- AO daemon health: `ao status --json`.
- Orchestrator rows: `ao orchestrator ls --json`.
- Project sessions: `ao session ls --json -p orchestrator-pack --all`.
- Targeted session recycle: `ao session kill` / `ao session restore`.
- Pack side-process state: `scripts/orchestrator-wake-supervisor.ps1 -Action Status`.
- Worker lifecycle: pack worker-report/status stores.
- Review state: pack review-run store and current GitHub head/status.

Do not assume the bulk session list contains `branch`, `prs[]`, `prNumber`, `.pr`, or
`ownedHeadSha`. Durable PR ↔ session binding is pack-owned and is not reconstructed from
AO review state.

AO review HTTP API, `ao review submit`, and reviewer configuration remain available
upstream in AO 0.10.3, but are retired by this pack. They are not recovery, fallback, or
dual-write paths.

## Before mutation

Capture:

```bash
git status --short
ao status --json
ao orchestrator ls --json
ao session ls --json -p orchestrator-pack --all
```

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

Also capture current GitHub PR/head/check state and list pack-owned runs using the
canonical runbook. Do not kill or restore a session during a push, message submission, or
another operator's adoption step.

## Least-invasive order

1. Diagnose one affected worker, orchestrator session, or pack child.
2. Use one bounded journaled nudge only when the target is confirmed live.
3. Restart only the affected pack side-process supervisor when its fleet is unhealthy.
4. Recycle only the affected AO session after checking fragile work is not in flight.
5. Use `ao stop` / `ao start` only for AO daemon health.

Restarting AO is not reviewer adoption. A changed `PACK_REVIEWER` requires pack supervisor
restart, not AO restart.

## Review-related recovery boundary

For no-start, failed reviewer, malformed payload, stale run, head drift, or incomplete
delivery, follow [`pack-review-runbook.md`](pack-review-runbook.md). Do not reproduce its
trigger, exact-head, channel, retry/resume, or merge rules here.

Minimum safety rules:

- preserve the pack journal and logs;
- never edit run, binding, claim, or delivery JSON by hand;
- never synthesize findings or a clean verdict;
- never use a different-head result;
- never reactivate AO Reviews as a pack fallback;
- never merge from an AO-managed worker.

## CI and worker recovery

Workers own red-CI self-fix. Autonomous dead-worker recovery is limited to an already
assigned unfinished task and must fail closed on ambiguous identity, liveness, PR, or head
state. Operator kill suppresses automatic recovery.

When a replacement session claims an existing PR, verify the installed AO 0.10.3 command
shape directly. The result of `session claim-pr` may include `prs[]`; that does not make
`prs[]` a field of bulk `ao session ls --json`.

## Diagnostics

```powershell
pwsh -NoProfile -File scripts/orchestrator-diagnose.ps1
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -File scripts/check-vestigial-fleet-children-retired.ps1 -Json
```

Historical pre-#898 recovery procedures are archived and are not current instructions.
