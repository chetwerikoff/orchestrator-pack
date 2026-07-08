# Wake supervisor ordinary Start must survive launcher exit

GitHub Issue: #552

## Prerequisite

- `docs/issues_drafts/60-orchestrator-wake-supervisor.md` (GitHub #168) — already defines the wake supervisor entry point and the detached-from-launching-terminal contract.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205) — already generalizes the supervisor to the registry-managed side-process set.
- `docs/issues_drafts/124-supervisor-empty-pid-file-start-crash.md` (GitHub #388) — already hardens `Start` / `Status` against empty pid-file crashes.
- `docs/issues_drafts/150-review-ready-seed-long-tick-liveness-heartbeat.md` (GitHub #473, closed by PR #551) — already fixes seed progress freshness during long GitHub refresh; this issue must not reopen that scope.

## Goal

`scripts/orchestrator-wake-supervisor.ps1 -Action Start` must satisfy the already-shipped detach contract under normal operator use: after the launching command exits, the supervisor process remains alive and keeps its managed children under supervision without requiring a manual shell-level workaround.

```behavior-kind
action-producing
```

## Binding surface

- Ordinary operator `Start` on Linux/macOS must launch the supervisor loop outside the lifetime of the invoking command's terminal/process wrapper.
- The implementation mechanism is planner-owned. The task may use process-session, process-group, shell wrapper, PowerShell, or platform-specific primitives as long as the observable detach contract holds.
- Existing `Status` and `Stop` semantics remain the operator interface for checking and shutting down the supervisor.
- Windows behavior must remain supported; if the Linux/macOS fix has no Windows equivalent, Windows must keep the existing supported hidden/detached process behavior.
- **Operator adoption:** after merge, restart the wake supervisor from the primary pack checkout with ordinary `Stop` then ordinary `Start`, wait past the previous failure window, and confirm `Status` reports the supervisor running.

```contract-evidence
none
```

## Files in scope

- `scripts/orchestrator-wake-supervisor.ps1`
- `scripts/lib/Orchestrator-SideProcessSupervisor.ps1`
- `scripts/orchestrator-wake-supervisor.test.ts`
- `scripts/fixtures/orchestrator-wake-supervisor/**`
- `docs/migration_notes.md`

## Files out of scope

- Seed GitHub refresh progress / liveness behavior from #473 / PR #551.
- GitHub REST / GraphQL quota policy.
- Adding, removing, or changing registry child responsibilities.
- AO core or vendored upstream packages.
- Live runtime state under `~/.local/state/**` or `.agent-orchestrator/**`.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
~/.local/state/**
.agent-orchestrator/**
```

```allowed-roots
scripts/**
docs/**
```

## Acceptance criteria

1. Ordinary `Start` survival: on Linux/macOS, a test or fixture starts the supervisor through the same non-foreground `-Action Start` path operators use, lets the launcher command exit, waits longer than one poll cycle, and proves the recorded supervisor pid is still alive.

```positive-outcome
asserts: ordinary -Action Start leaves a running supervisor process after the launcher command exits
input: realistic
```

2. Managed children remain supervised after launcher exit: after ordinary `Start` survival is proven, `Status` reports the supervisor `running` and registry children in working or explicitly managed non-working states, not all stopped because the launcher exited.

3. Ordinary `Stop` still works: after the survival scenario, `-Action Stop` terminates the supervisor and managed children cleanly and `Status` no longer reports the old supervisor pid as running.

4. Platform compatibility is explicit: Linux/macOS detach behavior is covered by the regression test, and existing Windows start/stop/status tests remain green or have an equivalent Windows assertion when the test environment supports it.

5. The fix does not prescribe `setsid` as the contract. Tests assert observable survival and clean stop behavior, not a specific OS primitive, so a planner can choose the cheapest sufficient platform mechanism.

6. Operator documentation captures the adoption step and the regression signal: ordinary `Start` previously required a manual detach workaround in the live terminal wrapper; after the fix, ordinary `Start` is the supported path.

## Upgrade-safety check

- No edits to Composio AO core or vendored upstream packages.
- No unsupported `agent-orchestrator.yaml` fields.
- No secrets, tokens, or machine-local live state committed.
- No regression of the #473 / PR #551 seed-progress contract.
- No broad rewrite of wake-supervisor child lifecycle or GitHub quota handling.

## Verification

```powershell
npm test -- orchestrator-wake-supervisor
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
Start-Sleep -Seconds 40
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/check-reusable.ps1
```

## Decisions

### Prior art

The shipped contracts #168 and #205 already require detached supervisor-managed processes; #388 hardens a separate `Start` crash around empty pid files; #551 fixes seed progress freshness and is not part of this task. Targeted REST search and corpus reconnaissance found no open issue specifically owning the ordinary `Start` launcher-exit regression. This draft is therefore an extension/regression repair against the existing detach contract, not a new supervisor architecture.

### Design note

The live 2026-06-30 adoption found that a manual `setsid nohup ... -SupervisorLoop ...` start survived the terminal wrapper, while ordinary `-Action Start` did not in that environment. That observation is evidence for the failure mode, not a required implementation shape. The planner should fix the class "launcher exit kills detached supervisor" and prove the observable contract.
