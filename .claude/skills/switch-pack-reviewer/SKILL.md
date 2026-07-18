---
name: switch-pack-reviewer
description: >-
  Switch the pack-owned local PR reviewer between Codex and Claude through
  PACK_REVIEWER, restart the pack side-process supervisor when needed, and verify
  the effective selector and wrapper. Use for reviewer switching, quota fallback,
  or Process/User selector drift.
---

# Switch pack reviewer (`PACK_REVIEWER`)

Canonical docs: [`docs/reviewer-switch-runbook.md`](../../../docs/reviewer-switch-runbook.md).
Review runtime: [`docs/pack-review-runbook.md`](../../../docs/pack-review-runbook.md).

## Contract

- `scripts/pack-review-runner.ts` owns review invocation.
- `scripts/invoke-pack-review.ps1` owns reviewer-agnostic dispatch.
- `PACK_REVIEWER=codex|claude` selects the wrapper.
- AO does not spawn the pack reviewer.
- Supported Linux/WSL selection is inherited from the process environment of the
  pack side-process supervisor.
- Windows compatibility may resolve Process → User → Machine layers.

## Procedure

### 1. Inspect

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
```

Record Process/User/Machine and the effective wrapper. Warn when Process scope
unexpectedly overrides a persistent Windows User value.

### 2. Apply

```powershell
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 \
  -Reviewer <codex|claude> \
  -RestartSupervisor
```

This sets the appropriate environment layer, restarts the pack supervisor, and
verifies the result. `-RestartAo` is a deprecated compatibility alias that must
restart the pack supervisor only.

### 3. Preflight the selected CLI

Codex:

```bash
codex --version
```

Claude:

```bash
claude --version
```

### 4. Verify selector

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1 \
  -Expected <codex|claude>
```

Pass means the effective selector and wrapper match.

### 5. Optional exact-head smoke

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --session-id <worker-session-id>
node --experimental-strip-types scripts/pack-review-runner.ts list \
  --project-id orchestrator-pack
```

Inspect pack-store/log evidence for the expected wrapper. Do not rely on retired AO
review-session state as proof.

## Failure handling

| Symptom | Action |
| --- | --- |
| Effective unset | Set the selector in the environment that starts the supervisor |
| Wrong model on Linux/WSL | Restart the pack supervisor after changing process scope |
| Wrong model on Windows | Clear stale Process scope; verify User value |
| Codex quota/auth failure | Switch to Claude and start a new current-head run |
| Claude unavailable | Install/configure Claude or switch to Codex |
| Delivery failed after verdict | Inspect pack-store channel outcomes; resume journaled delivery instead of recomputing review |

## Report

Tell the user:

- selected reviewer;
- effective layer/value;
- whether the pack supervisor was restarted;
- selector verification result;
- smoke run ID/status when a smoke was requested;
- any old terminals that still need reopening.

## Forbidden

- Do not edit a YAML reviewer command to switch models.
- Do not restart AO as reviewer adoption.
- Do not invoke per-reviewer wrappers directly as the live trigger.
- Do not treat a delivery-channel failure as proof that reviewer computation failed.
