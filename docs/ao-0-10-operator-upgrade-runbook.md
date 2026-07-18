# AO 0.10.x operator upgrade runbook

Operator guide for upgrading the live AO binary while preserving pack worker/session
safety and the independent pack-owned review pipeline.

Review operations: [`pack-review-runbook.md`](pack-review-runbook.md).

## Boundary

- Installing/upgrading AO is operator work after merge.
- CI cannot change the operator's binary.
- Live AO configuration is ProjectConfig and session state.
- Pack review is not an AO reviewer harness. It is invoked by
  `scripts/pack-review-runner.ts` and selected with `PACK_REVIEWER`.
- Upgrading AO must not reintroduce daemon review invocation/status as a fallback.

## Select the target release

At execution time, resolve the newest acceptable stable upstream GitHub release and
verify whether the matching npm/platform package is actually published. Do not rely
on an old captured “latest” value.

Use the pack `gh` wrapper for GitHub reads and record:

- tag and publication time;
- asset names/platform/architecture;
- upstream checksums/signatures when available;
- package-registry availability;
- current installed binary path/version;
- rollback artifact or install method.

Abort when an asset lacks required integrity evidence unless the operator explicitly
accepts the documented upstream gap.

## Pre-upgrade snapshot

```bash
command -v ao
ao --version
type ao
```

```bash
ao status --json
ao orchestrator ls --json
ao session ls --json -p orchestrator-pack --all
```

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
pwsh -NoProfile -File scripts/verify.ps1
```

Also record open PRs/current heads and pack review runs:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list \
  --project-id orchestrator-pack
```

## Hard gates

### Spawn/session command shape

Verify the target binary supports the project/name/session commands used by current
pack recovery and worker orchestration. Missing required flags blocks adoption.

### JSON output shape

Capture and compare the current commands actually parsed by the pack, including:

- daemon health;
- orchestrator list;
- project session list;
- project config reads/writes;
- any other live command named by the changed version's adoption issue.

Do not require or capture retired daemon review-session rows as an upgrade gate.
Pack review status comes from the pack store.

### Pack-owned reviewer

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
```

Confirm:

- effective selector is `codex` or `claude`;
- selected CLI exists on `PATH` in the environment inherited by the pack supervisor;
- `scripts/pack-review-runner.ts` and trusted reviewer entrypoint are present;
- the pack supervisor can be restarted independently of AO;
- branch protection requires `orchestrator-pack/pack-review` when the journal-first
  review delivery contract has been adopted.

The example YAML is not reviewer configuration, and an AO daemon restart is not
reviewer adoption.

### Repository verification

```powershell
pwsh -NoProfile -File scripts/check-ao-operator-upgrade-preflight.ps1
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

These normal repository checks are the complete verification set for this runbook;
do not introduce a separate documentation-only checker.

## Install

Use the verified package/asset for the operator platform. Keep the previous binary
or a reproducible rollback method until all post-upgrade checks pass.

After install:

```bash
ao --version
command -v ao
```

## Adopt live runtime

1. Apply any required ProjectConfig changes.
2. Restore/recycle only sessions that must inherit changed AO configuration.
3. Restart the pack side-process supervisor when its executable path, environment,
   registry, or `PACK_REVIEWER` inheritance changed:

   ```powershell
   pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
   pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
   ```

4. Do not overwrite a local ignored configuration file from the example.
5. Do not discard unknown worktree changes.

Restart AO only when daemon health/install adoption requires it. Use the AO 0.10
supported start command shape; there is no reviewer-specific project-start step.

## Post-upgrade verification

### AO/session health

```bash
ao status --json
ao orchestrator ls --json
ao session ls --json -p orchestrator-pack --all
```

### Pack side-process health

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -File scripts/check-vestigial-fleet-children-retired.ps1 -Json
```

### Pack review smoke

On a safe open PR/current head:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --session-id <worker-session-id>
node --experimental-strip-types scripts/pack-review-runner.ts list \
  --project-id orchestrator-pack
```

Verify:

- exact current head binding;
- expected reviewer wrapper;
- durable verdict/findings journal;
- GitHub COMMENT outcome;
- `orchestrator-pack/pack-review` exact-head status outcome;
- worker-notification outcome;
- no duplicate reviewer computation on same-head delivery resume.

### Worker/session smoke

Use disposable or harmless sessions to confirm:

- truly dead sessions do not resurrect incorrectly;
- restore uses current ProjectConfig;
- live sessions are not killed by stale reconciliation;
- worktree isolation remains intact.

## Rollback

Rollback when:

- binary/asset integrity fails;
- required command or JSON shapes are missing;
- ProjectConfig/session restore breaks;
- the pack supervisor cannot run current children;
- the pack reviewer cannot resolve selector/trusted root/store;
- exact-head review/status behavior fails.

Restore the captured previous binary/install method, restore prior ProjectConfig if
changed, recycle only affected sessions/processes, and rerun the complete verification
set. Do not weaken guards or resurrect retired review paths to make the upgrade pass.

## Operator record

Record:

- old/new binary versions and paths;
- release/asset/checksum evidence;
- ProjectConfig changes;
- sessions/processes recycled;
- pack supervisor status;
- reviewer selector and smoke run ID;
- rollback readiness;
- any follow-up issue needed for output-shape drift.
