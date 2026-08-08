# Autonomous review loop — operator go-live

This checklist enables the pack-owned review and reconciliation loop without a
concrete runtime command, configuration file, daemon API, or state database.

## Active authorities

| Capability | Tracked authority |
|---|---|
| Worker and review policy | `AGENTS.md` |
| Review start, list, status, claim, cap, and publication | `scripts/pack-review-runner.ts` and the pack review store |
| Reviewer selection | `PACK_REVIEWER` through the tracked reviewer resolver |
| Side-process supervision | `scripts/orchestrator-wake-supervisor.ps1` and `scripts/orchestrator-side-process-registry.json` |
| Review eligibility reconciliation | `scripts/review-trigger-reconcile.ps1` and `scripts/review-trigger-reeval.ps1` |
| Ready-report seeding | `scripts/review-ready-report-state-seed.ps1` |
| CI transitions | `scripts/ci-green-wake-reconcile.ps1` and `scripts/ci-failure-notification-reconcile.ps1` |
| Worker message reconciliation | `scripts/worker-message-submit-reconcile.ps1` |
| Stale review-claim cleanup | `scripts/review-start-claim-reaper.ps1` |
| Dead-worker reconciliation | `scripts/dead-worker-reconcile.ps1` |
| Escalation delivery | `scripts/orchestrator-escalation-router.ps1` through the registered runtime adapter |

The loopback listener, heartbeat, legacy review send reconciliation, worktree trust
watcher, and removed runtime transport are not active fallback paths.

## Prerequisites

- Node.js 22.x and the frozen workspace dependencies;
- PowerShell 7+ for retained PowerShell entrypoints;
- authenticated GitHub transport;
- the configured reviewer CLI;
- a registered runtime adapter for the exact operations that require one.

Verify the checkout before starting managed processes:

```powershell
npm ci --include=dev
pwsh -NoProfile -File scripts/verify.ps1 -StrictPrereqs
pwsh -NoProfile -File scripts/check-reusable.ps1
```

## Start and inspect the pack-owned supervisor

```powershell
cd <orchestrator-pack-root>
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

The status command must report the nine children defined by
`scripts/orchestrator-side-process-registry.json`. It must not report any retired
listener, heartbeat, review-send reconciler, worktree-trust watcher, or removed
fleet child.

Stop the managed fleet with:

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
```

The supervisor may use its documented `OPK_WAKE_SUPERVISOR_*` inputs. A
session-bound child still requires an adapter-produced exact
`{ runtime, id, generation }` identity. A process ID, title, path, short ID, stale
store row, or environment string alone is not authority.

## Review loop

```text
worker PR/report/CI state
    → pack-owned reconciliation reads current GitHub and pack state
    → exact-head eligibility and coverage decision
    → pack review runner starts one claimed review when required
    → single publication owner delivers the terminal verdict
    → worker addresses findings or completes current-head handoff
```

Common review entrypoints:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list --pr-number <PR_NUMBER>
node --experimental-strip-types scripts/pack-review-runner.ts status --pr-number <PR_NUMBER>
npm run --silent pack-gpt-review -- --pr-number <PR_NUMBER>
```

Use the exact command contract exposed by the current runner version. Do not invoke
one reviewer plugin as a substitute for claims, cap, head binding, run-store state,
or the single publication owner.

## Manual isolation checks

When debugging one child, use its documented `-Once -DryRun` or fixture mode when
available. A dry run must not dispatch, mutate durable state, or reinterpret an
unresolved identity as permission.

Useful checks:

```powershell
pwsh -NoProfile -File scripts/check-vestigial-fleet-children-retired.ps1 -Json
pwsh -NoProfile -File scripts/check-side-process-launch-contract.ps1
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
node --experimental-strip-types scripts/runtime-retirement/retired-surface-selftest.ts
```

## Pass criteria

- the current checkout passes repository verification;
- the supervisor reports the exact nine-child roster with no retired child;
- one eligible current PR head receives at most one active claimed review start;
- failed, cancelled, malformed, or empty review output remains non-clean;
- a clean terminal review is bound to the same PR head;
- open findings keep the worker engaged;
- CI and smoke evidence bind to the same current head;
- no runtime effect occurs without exact adapter identity;
- no removed command, API, configuration, state root, alias, or fallback is used.

## Operator adoption

After a merge that changes the registry, supervisor, runtime adapter registration,
or operator-owned input:

1. stop affected managed processes;
2. deploy the exact merged checkout;
3. apply only the explicit operator-owned input change documented in
   `docs/migration_notes.md` and the PR body;
4. restart affected processes;
5. read back the roster, runtime registration, current commit, and one representative
   operation;
6. preserve exact failure evidence when a check does not pass.

Do not mutate the operator host from a managed worker unless the direct user orders
that exact action.

## Recovery

Use `docs/orchestrator-recovery-runbook.md` for supervisor and identity recovery,
`docs/orchestrator-wake-runbook.md` for fleet wiring, and
`docs/reviewer-switch-runbook.md` for reviewer selection. Recovery never restores a
removed runtime route or treats silence as proof that a process is dead.
