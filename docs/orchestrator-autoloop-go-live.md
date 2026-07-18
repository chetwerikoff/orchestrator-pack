# Autonomous pack loop — operator go-live

This checklist enables the pack side-process fleet on AO 0.10.3. The complete review
contract is [`pack-review-runbook.md`](pack-review-runbook.md).

## Prerequisites

Verify Node, Git, authenticated `gh`, PowerShell, AO, and the selected reviewer CLI.
Then run:

```powershell
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
```

Live AO settings use supported ProjectConfig fields. `agent-orchestrator.yaml.example` is
a legacy-import example, not live worker/review/reaction policy.

## Start the pack supervisor

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

After changing `PACK_REVIEWER`, restart this supervisor. Restarting AO is not reviewer
adoption.

## Current review boundary

- starts enter `scripts/pack-review-runner.ts`;
- reviewer dispatch uses `scripts/invoke-pack-review.ps1`;
- durable binding and run state are pack-owned;
- AO Reviews remain upstream but are retired by this pack;
- the Reviews Board is historical;
- no live path uses deleted listener, review-recovery, or finding-confirm children.

Do not duplicate trigger, exact-head, delivery, resume, switching, or merge semantics in
this checklist; follow the canonical runbook.

## Worker and CI handoff

Workers use `pack-worker-report` and report `ready_for_review` only for a current head with
green required CI. Current-head findings move the worker to `addressing_reviews`; the
worker fixes them, restores CI, and reports the new head. Only the operator merges.

## Post-merge adoption

1. Pull merged `main` in the operator checkout.
2. Follow the PR's `## Operator adoption` section.
3. Restart affected pack side processes.
4. Recycle sessions that need merged tracked rules/worktrees.
5. Apply required branch-protection changes.
6. Verify one safe current-head run using the canonical runbook.

Recovery procedures: [`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md).
