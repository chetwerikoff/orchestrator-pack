# Wake supervisor must tolerate empty child `.pid` files (Start/Status must not crash)

GitHub Issue: #388

## Prerequisite

- `docs/issues_drafts/60-orchestrator-wake-supervisor.md` (GitHub #168) — the
  supervised entry point and pid-file liveness model this issue hardens.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205) —
  generalizes #168 to the full side-process registry; `Read-OrchestratorWakeSupervisorPidFile`
  is shared by supervisor and every child status path.
- `docs/issues_drafts/81-reconcile-state-roundtrip-and-supervisor-health.md`
  (GitHub #248) — extends Status to real workability; **gap this issue closes:**
  #248 assumes pid files are readable; it does not cover the **zero-byte pid file**
  class that makes Status/Start throw before any stale-pid cleanup runs.

## Goal

`orchestrator-wake-supervisor.ps1 -Action Start` and `-Action Status` must never
terminate with a PowerShell null-dereference because a supervised child's `.pid`
file exists but is **empty** (0 bytes). An empty pid file must be treated the same
as a missing or unparsable pid: **pid = 0**, so existing stale-pid cleanup and
status reporting can proceed.

```behavior-kind
action-producing
```

Success path: operator runs `-Action Start` or `-Action Status` while one or more
registry children have zero-byte pid files; the command completes (Start detaches
the supervisor and prints status; Status exits 0 or 1 based on health, not a
script exception).

```contract-evidence
none
```

No upstream AO/gh/codex producer field is bound. The failure is a local PowerShell
read helper on on-disk pid files the supervisor itself manages.

## Background (confirmed root cause)

Live incident 2026-06-21 on WSL/Linux:

```
pwsh -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
orchestrator-wake-supervisor.ps1: You cannot call a method on a null-valued expression.
```

Stack:

```
Read-OrchestratorWakeSupervisorPidFile  (Orchestrator-SideProcessSupervisor.ps1:328)
  → Get-OrchestratorWakeSupervisorChildStatusEntry
  → Get-OrchestratorWakeSupervisorStatusReport
  → Start (post-detach status output)
```

`Read-OrchestratorWakeSupervisorPidFile` does
`(Get-Content -LiteralPath $Path -Raw).Trim()`. On a **zero-byte** file,
`Get-Content -Raw` returns `$null`; calling `.Trim()` throws.

State dir held empty pid files including
`ci-failure-notification-reaction.pid` and `ci-green-wake-reconcile.pid` (0 bytes).
`Clear-OrchestratorWakeSupervisorStalePidIfNeeded` already removes pid files when
pid ≤ 0, but it is never reached for empty files because **Read throws first**.

Deleting the empty files unblocked Start immediately; the code path remains fragile.

## Binding surface

- **Empty pid file ≡ no pid.** If the pid file exists as a leaf but its raw content
  is null, empty, or whitespace-only, `Read-OrchestratorWakeSupervisorPidFile`
  returns `0` without throwing. This matches the existing contract for missing
  files and non-numeric content.
- **No change to valid pid semantics.** A file containing a parseable positive
  integer still returns that pid; behavior unchanged for the happy path.
- **Stale cleanup remains authoritative.** Returning `0` for empty files lets
  `Clear-OrchestratorWakeSupervisorStalePidIfNeeded` remove the empty file on the
  next Status/Start pass (existing behavior for pid=0). This issue does **not**
  require tracing why zero-byte files are created (possible start/stop race); it
  only requires the read path to be crash-proof.
- **All callers inherit the fix.** Every path that reads child or supervisor pid
  files through `Read-OrchestratorWakeSupervisorPidFile` (Start, Status, supervisor
  loop, child restart) must benefit from the single chokepoint — no duplicate
  one-off guards at call sites.

## Files in scope

- `scripts/lib/Orchestrator-SideProcessSupervisor.ps1` — `Read-OrchestratorWakeSupervisorPidFile`.
- `scripts/orchestrator-wake-supervisor.test.ts` (or adjacent PS test surface the
  planner chooses) — regression for zero-byte pid file on at least one child role
  and on the supervisor pid path used by Status/Start.

## Files out of scope

- `packages/core/**`, `vendor/**`, `.ao/**`.
- `agent-orchestrator.yaml` / `*.yaml.example` — no wiring change.
- Root-cause work on **how** zero-byte pid files get written (atomic write,
  temp-rename) — follow-up only if recurrence persists after this read guard.

## Denylist / allowed-roots

Deny: `vendor/**`, `packages/core/**`, `.ao/**`. Allow: `scripts/**` only.

## Operator adoption

None. Script-only fix; restart supervisor optional after merge (`-Action Stop` then
`-Action Start`) but not required for the read guard itself.

## Acceptance criteria

```positive-outcome
asserts: with a zero-byte child pid file present in the supervisor state dir, orchestrator-wake-supervisor.ps1 -Action Status completes without a terminating PowerShell error and reports that child as stopped (pid=0); -Action Start completes without a terminating PowerShell error and prints status output (children may legitimately restart — Start is not required to leave them stopped)
input: realistic
```

1. **Zero-byte child pid, Status.** Given a registry child pid file that exists and
   is 0 bytes, `orchestrator-wake-supervisor.ps1 -Action Status` completes without
   a terminating error; the child reports `stopped` (pid=0), not a script crash.
2. **Zero-byte child pid, Start.** Same fixture state: `-Action Start` completes
   without a terminating error and prints status output. Start may detach a new
   supervisor and restart children — the contract is **no crash**, not that the
   child remains stopped afterward.
3. **Zero-byte supervisor pid.** Same for `supervisor.pid` at 0 bytes — Read
   returns 0; Start/Status do not throw.
4. **Valid pid unchanged.** A pid file containing `12345` still reads as `12345`
   (regression).
5. **Whitespace-only pid.** A pid file containing only `\n` or spaces reads as `0`
   without throwing (same class as empty).
6. **Stale cleanup (observable).** After `-Action Status` with a zero-byte child
   pid file, that pid file is **absent** on disk (removed by existing pid≤0
   stale cleanup). Fixture asserts the file is gone, not merely that a cleanup
   helper exists.

## Upgrade-safety check

Pack-only change under `scripts/**`; no Composio core or AO schema dependency.

## Verification

```powershell
pwsh -NoProfile -File scripts/verify.ps1
# plugin/supervisor tests as documented for scripts/orchestrator-wake-supervisor.test.ts
```

Manual repro (pre-fix fails, post-fix passes):

```powershell
$state = Join-Path $HOME '.local/state/orchestrator-pack-wake-supervisor'
New-Item -ItemType File -Path (Join-Path $state 'ci-green-wake-reconcile.pid') -Force | Out-Null
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

## Decision log

- **Cheapest sufficient fix:** harden the single read chokepoint so null/empty/whitespace
  content returns `0` without throwing (illustrative: guard before `.Trim()` on
  `Get-Content -Raw`). Atomic pid writes deferred unless empty files recur after
  ship.
