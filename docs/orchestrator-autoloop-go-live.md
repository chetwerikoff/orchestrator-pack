# Autonomous review loop — operator go-live

This checklist enables the side-process review/CI loop on AO 0.10.2 with the
pack-owned reviewer. Review commands and authority:
[`pack-review-runbook.md`](pack-review-runbook.md).

## Live architecture

- AO provides project/session lifecycle and worker terminals.
- `AGENTS.md` provides worker policy.
- Pack side processes observe worker reports, GitHub PRs, CI, and local stores.
- All review starts converge on `scripts/pack-review-runner.ts`.
- The pack review-run store records lifecycle, durable verdict/findings, and delivery
  outcomes.
- GitHub COMMENT is presentation; `orchestrator-pack/pack-review` is exact-head merge
  authority.
- Workers are notified through an independent journaled channel.
- The LLM orchestrator does not manually drive routine review rounds.

## Prerequisites

```bash
node --version
git --version
gh auth status
pwsh --version
codex --version   # or claude --version
```

Verify selector:

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
```

Verify pack:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

## Operator processes

### AO

Start AO for the intended repository/project using the supported AO 0.10.2 command
shape. ProjectConfig, not the example YAML, is live runtime configuration.

### Pack side-process supervisor

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
```

Status/stop:

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
```

The registry owns the current reconcile, CI, worker-message, recovery, and escalation
children. Deleted listener/heartbeat/finding-confirm paths are not started.

After changing a process-scoped `PACK_REVIEWER` value on Linux/WSL, restart this
supervisor so children inherit the new environment:

```powershell
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 \
  -Reviewer <codex|claude> -RestartSupervisor
```

## Review loop

```text
worker implements issue
  -> pushes PR linked with Closes/Fixes/Resolves #N
  -> fixes required CI
  -> pack-worker-report ready_for_review on current green head
  -> side-process readiness/coverage/claim recheck
  -> pack-review-runner exact-head review
  -> durable verdict/findings journal
  -> GitHub COMMENT + required status + worker notification
  -> findings: worker addressing_reviews -> fixes -> new head -> repeat
  -> clean/non-blocking + green required CI: operator merge decision
```

## Automatic review starters

The low-frequency review reconcile is the zero-signal backstop. Deferred-head
re-evaluation and report-state seed provide additional current-head coverage. Every
starter uses the shared readiness predicate and per-(PR, head) claim.

No starter may:

- create an independent reviewer session;
- bypass exact-head validation;
- start two active same-head runs;
- infer review readiness from worker text alone;
- merge the PR.

## Manual review

Use a manual start only for an explicit operator action or safe smoke test. The
canonical command forms and status query live in
[`pack-review-runbook.md`](pack-review-runbook.md#manual-start). Manual operation
shares the trusted runner, exact-head checks, store, journal, and delivery state
machine with automatic starts.

## Worker states

Expected progression:

- `working` / `pr_created` while implementation or CI work remains;
- `fixing_ci` while required checks are not green;
- `ready_for_review` only for the current green head;
- `addressing_reviews` after findings are delivered;
- `completed` only for terminal non-review work or the explicit degraded-CI handoff
  contract; never as a substitute for open review findings.

Worker state comes from the pack worker-report/status stores. Stale or ambiguous
ownership fails closed.

## Review result interpretation

A run can have:

- reviewer-process failure or timeout;
- malformed terminal payload;
- durable clean/findings verdict;
- independent success/failure for GitHub comment, required status, and worker
  notification.

Delivery failure after a valid durable verdict does not mean the reviewer failed.
Inspect the run's journal and channel outcomes and resume missing same-head delivery.

## Merge readiness

Before merge verify on the same current head:

1. `orchestrator-pack/pack-review` is successful;
2. required CI is green;
3. the PR is open and mergeable;
4. no other blocking review remains;
5. the durable pack run corresponds to the exact head;
6. operator-adoption requirements are understood.

The visible GitHub COMMENT is not merge authority by itself.

## Recovery

- No run after handoff: inspect readiness, exact-head ownership, CI, claim, and
  supervisor health.
- Reviewer failed: inspect stored stdout/stderr and selector/tool authentication.
- Run stale: verify the runner PID/heartbeat and allow the stale-claim policy to
  reclaim only when safe.
- Delivery incomplete: start the same PR/head again to resume journaled channels;
  do not force a duplicate reviewer computation.
- Worker idle after findings: inspect worker-notification outcome and dispatch
  journal, then use the normal journaled worker nudge/escalation path.

Detailed commands and forbidden shortcuts:
[`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md).

## Post-merge adoption

For every merged pack PR:

1. pull merged `main` in the operator checkout;
2. read its `## Operator adoption` instructions;
3. update ProjectConfig/environment if required;
4. restart affected pack side processes;
5. recycle worker/orchestrator sessions whose tracked rules or runtime worktrees must
   contain the merge;
6. apply branch-protection changes such as requiring
   `orchestrator-pack/pack-review` when specified;
7. verify current-head review/CI behavior on a safe open PR.

## Go-live evidence

Record supervisor health, the selected reviewer, one current-head pack run, the
required-status result, and any channel outcome needed for the adoption record. Use
the canonical runbook for review status and the recovery runbook for diagnostics;
do not introduce a parallel command checklist here.

Historical AO review commands and deleted script paths are not current recovery or
operator procedures.
