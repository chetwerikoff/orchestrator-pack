# Wake supervisor Stop/Status must discover orphaned detached supervisors

GitHub Issue: #613

## Prerequisite

- `docs/issues_drafts/124-supervisor-empty-pid-file-start-crash.md` (GitHub #388, closed) made empty or missing pid files read as pid `0`. That prevents crashes, but it also lets `Stop` and `Status` treat a missing supervisor pid as "no supervisor" without any process discovery fallback.
- `docs/issues_drafts/71-orchestrator-side-process-supervisor.md` (GitHub #205, closed) introduced registry-backed child adoption and termination, but it does not discover an already-running orphaned supervisor process when the supervisor pid file is missing.
- `docs/issues_drafts/179-wake-supervisor-ordinary-start-detach-regression.md` (GitHub #552, closed) requires ordinary `Start` to survive launcher exit. The same detached survival property means `Stop` and `Status` must not rely only on the launcher-era pid file.
- `docs/issues_drafts/60-orchestrator-wake-supervisor.md` (GitHub #168), `docs/issues_drafts/81-reconcile-state-roundtrip-and-supervisor-health.md` (GitHub #248), and `docs/issues_drafts/139-supervisor-crash-hardening-degraded-backoff-and-redirect-safety.md` (GitHub #450) define adjacent supervisor-health, status, and backoff contracts, none of which cover missing-`supervisor.pid` orphan-supervisor discovery.
- Live incident evidence from 2026-07-05 UTC: after the operator stopped the wake supervisor and children, `scripts/orchestrator-wake-supervisor.ps1 -Action Status -ProjectId orchestrator-pack` reported `supervisor: stopped (pid=0)` because `~/.local/state/orchestrator-pack-wake-supervisor/supervisor.pid` was missing. A live process still existed:
  `pwsh -NoProfile -ExecutionPolicy Bypass -File /home/che/projects/orchestrator-pack/scripts/orchestrator-wake-supervisor.ps1 -Action Start -SupervisorLoop -ProjectId orchestrator-pack -PollSeconds 120`
  with `PPID=1`, started at `2026-07-05T11:13:46Z`. At `2026-07-05T12:22:03Z`, new child processes appeared with that supervisor as parent, proving the old supervisor, not a new external launcher, restarted the children.
- Prior-art search verdict: `gh issue list` found no open issue for this exact gap. Closed issues #168, #205, #248, #388, #450, and #552 cover adjacent contracts but leave missing-`supervisor.pid` orphan-supervisor discovery unresolved.

## Goal

Make wake-supervisor `Stop`, `Status`, and duplicate-start prevention authoritative when `supervisor.pid` is missing, empty, stale, or points at an unrelated process. A pack-managed detached supervisor must be discovered by validated process identity, reported as running, stopped when requested, and prevented from restarting children after an operator stop.

```behavior-kind
action-producing
```

```complexity-tier
tier: T3
advisory-prior: T3
```

## Binding Surface

- `scripts/orchestrator-wake-supervisor.ps1` `-Action Stop`, `-Action Status`, and `-Action Start` behavior for `-ProjectId orchestrator-pack`.
- Supervisor pid-file reconciliation for missing, empty, stale, and unrelated pid values.
- Managed-supervisor discovery by strict command/process identity: the process must be PowerShell running this pack's `scripts/orchestrator-wake-supervisor.ps1` by resolved script path with `-Action Start`, `-SupervisorLoop`, and a `-ProjectId` equal to the queried project, or the default project when the flag is absent. State-root identity is derived from the project plus the default state-root resolution; when `-StateDir` is present it must match the expected state root, but absence of `-StateDir` must not disqualify the default operator command line. A prompt, shell command, log viewer, or unrelated PowerShell process containing similar text is not a managed supervisor.
- Child cleanup after the supervisor is stopped, including orphaned children whose parent became PID 1.
- Operator-visible `Status` output and `Stop` diagnostics for found, stopped, stale, ambiguous, or unsafe-to-kill supervisor states.

## Operator Adoption

No configuration migration is required. After implementation is merged on a machine with a live wake supervisor, the operator should restart the supervisor from the updated checkout so future `Stop`/`Status` calls use the fixed discovery logic. The implementation PR may add a short migration note for the one-time verification command, but it must not require edits to live `agent-orchestrator.yaml`.

## Files In Scope

- `scripts/orchestrator-wake-supervisor.ps1`
- The wake-supervisor library code that owns pid-file, managed-process identity, and stop/status helper behavior
- Wake-supervisor fixtures and tests under `scripts/**` and `tests/**`
- `docs/migration_notes.md` or another pack-owned operator note only if the implementation adds an operator-facing restart/verification step
- This issue draft and related documentation under `docs/**`

## Files Out Of Scope

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- `.agent-orchestrator/**`
- Live runtime state under `~/.local/state/**`
- Live `agent-orchestrator.yaml`
- Changing GitHub API rate-limit/backoff behavior from #450/#447.
- Adding or removing wake-supervisor child roles.
- Replacing the wake supervisor with systemd, cron, launchd, or another external process manager.

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
~/.local/state/**
agent-orchestrator.yaml
```

```allowed-roots
scripts/**
docs/**
tests/**
```

## Acceptance criteria

1. **Status discovers missing-pid supervisor:** Per the AC#11 rows for missing, empty, stale, and unrelated `supervisor.pid` values, `-Action Status -ProjectId orchestrator-pack` reports a live pack-managed supervisor as running with the discovered pid. It must not print the old false state `supervisor: stopped (pid=0)` while the managed supervisor is alive.

2. **Stop terminates missing-pid supervisor:** Per the AC#11 rows for missing, empty, stale, and unrelated `supervisor.pid` values, `-Action Stop -ProjectId orchestrator-pack` terminates the discovered supervisor and its children, exits successfully where the row allows success, and a post-stop check after more than one poll interval proves no managed children are restarted by the old supervisor.

```producer-emission
producer: orchestrator-pack
datum: wake-supervisor-stop
expected: missing-pid-supervisor-stopped
proof-command: implementation-specific missing-supervisor-pid Stop fixture
```

3. **Stale or unrelated pid is not trusted:** Per the AC#11 rows for stale and unrelated `supervisor.pid` values, `Status` and `Stop` do not treat the pid-file value as authoritative unless it still validates as the pack-managed wake supervisor. They either discover the real managed supervisor by validated identity or fail closed with a diagnostic explaining why no unambiguous managed supervisor could be selected. They must not kill the unrelated process.

4. **Start does not duplicate an orphan:** If `-Action Start -ProjectId orchestrator-pack` runs while `supervisor.pid` is missing or stale but exactly one managed supervisor is already alive, `Start` does not launch a second supervisor. It either adopts/reconciles the existing supervisor by writing the pid file or reports that the supervisor is already running.

```producer-emission
producer: orchestrator-pack
datum: wake-supervisor-start
expected: missing-pid-orphan-adopted-no-duplicate
proof-command: implementation-specific duplicate-start prevention fixture
```

5. **Ambiguous supervisors fail closed:** If multiple managed-supervisor candidates match the strict identity predicate, for example after a duplicate `Start` that AC#4 is meant to prevent or after a half-completed prior stop, `Status` and `Start` report an ambiguous-supervisor state and do not pretend the service is stopped. `Stop` must either stop only candidates that are proven to belong to the same project identity and compatible state-root resolution or fail closed with explicit manual-remediation diagnostics; it must not choose an arbitrary pid.

6. **Orphaned children are cleaned after supervisor stop:** When the supervisor is discovered by fallback process scan rather than by pid file, `Stop` still terminates registry children and orphaned managed child processes whose parent is already PID 1. The cleanup must use recorded pids and/or strict child command identity, not broad free-text prompt matching.

7. **No broad command-line false positive:** Regression fixtures include at least one non-supervisor process or captured command line containing the string `orchestrator-wake-supervisor.ps1` as inert text. Discovery does not select or kill it. The test proves the identity predicate requires the actual script path and supervisor-loop arguments, not just substring presence.

8. **Shared predicate blast radius is covered:** Tightening the managed-supervisor identity predicate is expected and in scope. Every existing caller of the shared managed-process check, including the `Start` already-running short-circuit, the `Stop` kill guard, and `Status` process filtering, must still recognize the genuine detached supervisor whose command line is shaped like `-Action Start -SupervisorLoop -ProjectId orchestrator-pack ...`. Regression coverage proves no caller starts rejecting the real supervisor after the predicate tightens.

9. **Kill re-validates discovered pids:** A pid obtained by process-scan discovery is re-validated against the strict managed-supervisor predicate immediately before termination, not only at discovery time. Discovery must route through the same identity kill guard as the pid-file path, so a pid that exits and is reused by an unrelated process between scan and kill is not killed.

10. **Happy path remains compatible:** With a valid `supervisor.pid` pointing to the live managed supervisor, existing `Start`, `Status`, and `Stop` behavior remains compatible except for the intended stricter identity check from AC#8. The #388 empty-pid behavior still does not crash, but empty/missing supervisor pid now triggers discovery rather than a false-stopped conclusion.

11. **Class matrix:** Verification covers at least these cells:

   | `supervisor.pid` state | Managed supervisor state | Expected `Status` | Expected `Stop` |
   | --- | --- | --- | --- |
   | valid pid | one live managed supervisor | running with pid | stops supervisor and children |
   | missing | one live managed supervisor | running with discovered pid | stops supervisor and children |
   | empty | one live managed supervisor | running with discovered pid | stops supervisor and children |
   | stale exited pid | one live managed supervisor | running with discovered pid plus stale-pid diagnostic | stops supervisor and children |
   | unrelated live pid | one live managed supervisor | running with discovered pid plus unrelated-pid diagnostic | does not kill unrelated pid; stops managed supervisor |
   | missing | no live managed supervisor | stopped with no false child restart | idempotent success or documented no-op |
   | missing | two managed candidates | ambiguous, not stopped | fail closed or stop only proven same-project candidates |
   | valid pid | unrelated process with prompt text only | not selected as supervisor | not killed |

```positive-outcome
asserts: with a live detached wake supervisor whose supervisor.pid is missing or stale, Status reports the managed supervisor as running and Stop terminates that supervisor plus its children so no child restarts after one poll interval
input: realistic
provenance: capture-backed
```

## Upgrade-Safety Check

The change is upgrade-safe because it stays in pack-owned scripts, tests, fixtures, and documentation. It does not patch Composio AO core or vendored packages. The discovery predicate must be anchored to pack-owned script paths, queried project identity, and state-root compatibility when observable so a future upstream AO upgrade cannot turn this into a broad process killer.

## Verification

- Regression fixture for missing `supervisor.pid` with one live detached supervisor, implemented with a controllable long-lived stand-in or a faked command-line/enumeration seam rather than requiring CI to spawn and reap a truly reparented daemon.
- Regression fixture for empty `supervisor.pid` with one live detached supervisor, using the same controllable process/command-line seam.
- Regression fixture for stale and unrelated pid-file values.
- Regression fixture for duplicate-start prevention when a managed orphan already exists.
- Regression fixture for ambiguous multiple managed-supervisor candidates.
- Regression fixture for discover-to-kill pid reuse or changed identity, proving termination re-validates the candidate immediately before killing.
- Regression fixture for non-supervisor command lines containing `orchestrator-wake-supervisor.ps1` as inert text.
- Discovery/enumeration behavior either degrades safely on non-Linux platforms through the existing command-line read abstraction or the implementation explicitly scopes live process discovery to Linux/WSL while keeping non-Linux `Status`/`Stop` failures classified and non-destructive.
- The `positive-outcome: capture-backed` claim is satisfied by replaying a captured real supervisor command line through the controlled process/command-line seam; it does not require a flaky real orphaned daemon in CI.
- Existing wake-supervisor and side-process-supervisor tests still pass.
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command positive-outcome -DraftPath docs/issues_drafts/205-wake-supervisor-stop-status-orphaned-supervisor.md`
- `pwsh -NoProfile -File scripts/check-draft-discipline.ps1 -Command contract-evidence -DraftPath docs/issues_drafts/205-wake-supervisor-stop-status-orphaned-supervisor.md`
- `pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath docs/issues_drafts/205-wake-supervisor-stop-status-orphaned-supervisor.md`

```contract-evidence
binding-id: orchestrator-pack:wake-supervisor-stop:missing-pid-supervisor-stopped
binding-type: cli-behavior
binding: Stop discovers a pack-managed detached wake supervisor when supervisor.pid is missing or empty, terminates it, terminates managed children, and proves no child restart after more than one poll interval
producer: orchestrator-pack
evidence: NEW(produced-by AC#2)

binding-id: orchestrator-pack:wake-supervisor-start:missing-pid-orphan-adopted-no-duplicate
binding-type: cli-behavior
binding: Start does not launch a duplicate wake supervisor when supervisor.pid is missing or stale but one pack-managed supervisor is already alive; it adopts or reports the existing supervisor instead
producer: orchestrator-pack
evidence: NEW(produced-by AC#4)
```

## Decisions

### Root cause

The root cause is not a new external launcher. The old detached supervisor remained alive after the operator stop because `Stop` trusted `Read-OrchestratorWakeSupervisorPidFile` returning pid `0` for the missing `supervisor.pid`. That made supervisor stop a no-op while the detached process continued polling and later restarted children. `Status` used the same pid-file-only premise, so it reported `supervisor: stopped (pid=0)` while `ps` showed the live `-SupervisorLoop` process.

### Prior-art verdict

This draft extends shipped contracts instead of replacing them. #388 correctly prevented empty pid files from crashing callers, #552 correctly made ordinary `Start` survive launcher exit, and #205 correctly handles child adoption. The missing piece is supervisor-level identity discovery and pid reconciliation when the supervisor pid file is absent or untrustworthy.

The local knowledge base did not contain a repo-specific fix note for this incident. General KB notes on process-manager state and message-history traceability reinforce two choices here: `Status` must report the evidence source it used, and recovery must reconcile durable state with live process reality rather than trusting one stale file.

`coworker` prior-art review reached the same conclusion: closed drafts cover adjacent layers, and no open/local draft covers the exact missing-`supervisor.pid` orphan-supervisor gap.

### Design analysis

Options considered:

| Option | Cost | Risk | Sufficiency | Decision |
| --- | ---: | ---: | ---: | --- |
| Keep pid-file-only behavior and document manual `ps` cleanup | Low | High: repeats silent false-stopped state and child restarts | Insufficient | Rejected |
| Add strict managed-supervisor discovery fallback and pid reconciliation in `Status`, `Stop`, and `Start` | Medium | Moderate: process matching must be precise | Sufficient | Chosen |
| Replace the wake supervisor with systemd/cron/launchd | High | High: changes deployment model and exceeds pack-owned script contract | Overbroad | Rejected |
| Kill every process whose command line mentions the supervisor script | Low | Critical: can kill prompts, shells, logs, or unrelated commands | Unsafe | Rejected |

The critical implementation mechanics are strict process identity, stale/unrelated pid-file handling, duplicate-start prevention, re-validation immediately before termination, orphaned-child cleanup after supervisor termination, and clear diagnostics when discovery is ambiguous.

### Decomposition

Kept as one draft. Splitting `Status`, `Stop`, and `Start` would leave unsafe intermediate states: `Status` might discover a supervisor that `Stop` cannot stop, or `Start` might create a duplicate while `Stop` is fixed. The smallest coherent fix is one shared discovery/reconciliation contract consumed by all three actions.