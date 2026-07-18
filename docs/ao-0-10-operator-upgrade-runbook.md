# AO 0.10.x operator upgrade runbook

Operator guide for changing the AO binary while preserving pack sessions and independent
pack-owned review.

Current review contract: [`pack-review-runbook.md`](pack-review-runbook.md).

## Boundary

- Upgrading AO is operator work.
- Live AO 0.10.3 configuration uses supported ProjectConfig fields.
- `agent-orchestrator.yaml.example` is not live policy.
- Pack review starts through `scripts/pack-review-runner.ts`, with reviewer selection by
  `PACK_REVIEWER` and dispatch through `scripts/invoke-pack-review.ps1`.
- AO review surfaces remain upstream but are retired by this pack; an upgrade must not
  activate them as fallback or dual-write paths.

## Before upgrade

Resolve the target release and package/asset at execution time. Record the installed AO
version/path, release artifact and integrity evidence, ProjectConfig, session inventory,
pack supervisor status, and rollback method.

```bash
command -v ao
ao --version
ao status --json
ao orchestrator ls --json
ao session ls --json -p orchestrator-pack --all
```

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
pwsh -NoProfile -File scripts/verify.ps1
```

Do not require AO review rows as an upgrade gate. Do not assume the bulk session list
contains PR binding fields.

## Compatibility gates

Verify the target AO binary still supports the command and JSON shapes used by current
project/session lifecycle, ProjectConfig, and targeted recovery. Missing required shape
blocks adoption.

Run normal repository checks:

```powershell
pwsh -NoProfile -File scripts/check-ao-operator-upgrade-preflight.ps1
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

## Install and adopt

1. Install the verified binary/package while retaining rollback capability.
2. Verify `ao --version` and binary path.
3. Apply required supported ProjectConfig changes.
4. Recycle only sessions that must inherit changed AO configuration.
5. Restart the pack supervisor when its executable path or environment changed.
6. Do not overwrite ignored live configuration from the tracked example.
7. Do not discard unknown worktree changes.

AO restart is for daemon/install health, not reviewer adoption. A reviewer selector change
uses pack supervisor restart.

## After upgrade

Verify AO/session health and the pack supervisor. Perform one safe pack review smoke only
through the canonical runbook; do not copy exact-head, channel, resume, or merge rules into
this upgrade guide.

Rollback when command/JSON compatibility, ProjectConfig/session restore, pack supervisor,
or pack-runner operation fails. Never weaken guards or reactivate AO Reviews merely to
make an upgrade pass.

Record versions, paths, integrity evidence, configuration changes, recycled sessions,
supervisor status, smoke evidence, and follow-up issues.
