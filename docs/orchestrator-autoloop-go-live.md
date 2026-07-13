# Autonomous review loop — operator go-live

One checklist to turn on the review loop that is **already implemented** in this
repo (Issues #28 / #39 / #60 — merged as PRs #42, #47, #65). AO does **not** run
Codex review when a worker spawns; the **orchestrator** and side-process scripts drive
`ao-review run` → auto-delivery on submit → worker `addressing_reviews` → re-review.

State-derived review reconciliation ([#163](https://github.com/chetwerikoff/orchestrator-pack/issues/163),
[#195](https://github.com/chetwerikoff/orchestrator-pack/issues/195)) runs via
`scripts/review-trigger-reconcile.ps1` (low-frequency, review-run only when the head is
**ready for review**).
The retired heartbeat and loopback listener are no longer part of the live loop. Periodic
registry children provide review and CI coverage; see the Issue #745 fleet reference below.

**AO 0.10 adoption (#623 / #625):** use `scripts/orchestrator-wake-supervisor.ps1` to supervise
all reconcile children; restart the supervisor (or `ao stop` / `ao start` when registry changes)
after merging harness updates. Live procedure is `AGENTS.md` + side-process scripts —
`orchestratorRules` in live YAML is legacy-import reference only.

After each merged worker PR, run that PR's **`## Operator adoption`** checklist
and the matching steps in
[`docs/migration_notes.md`](migration_notes.md#operator-adoption-contract)
(three-role contract — architect specs, worker documents, operator executes).

## What is already in the repo

| Capability | Where |
|------------|--------|
| Autonomous loop rules (legacy reference) | `agent-orchestrator.yaml.example` → `orchestratorRules` |
| Live worker + orchestrator review contract | `AGENTS.md` |
| Pack review command | `scripts/invoke-pack-review.ps1` (**REVIEW_COMMAND**; **PACK_REVIEWER** selects wrapper) |
| AO 0.10 review shim | `scripts/ao-review.ps1` (`run` / `list`; `send`/`execute` REMOVED) |
| Switch Codex ↔ Claude Sonnet | Set `PACK_REVIEWER` — [`reviewer-switch-runbook.md`](reviewer-switch-runbook.md) |
| Side-process supervisor (all autoloop children) | `scripts/orchestrator-wake-supervisor.ps1`, `scripts/orchestrator-side-process-registry.json` (Issues #168, #202, #205) |
| Wake ingress | **REMOVED by Issues #721 / #745** — no listener, heartbeat, port, or webhook contract |
| Review-trigger reconcile | `scripts/review-trigger-reconcile.ps1`, `docs/review-trigger-reconcile.mjs`, `docs/review-head-ready.mjs` (Issues #163, #195) |
| CI-green worker wake | `scripts/ci-green-wake-reconcile.ps1`, `docs/ci-green-wake-reconcile.mjs` (Issue #191) |
| First-send review delivery reconcile | **REMOVED on AO 0.10** — `scripts/review-send-reconcile.ps1` stub only (Issue #202 / #625) |
| Worker message submit reconcile | `scripts/worker-message-submit-reconcile.ps1`, `docs/worker-message-submit-reconcile.mjs` (Issue #232) |
| Terminal mux flood detect | `scripts/terminal-flood-detect.ps1`, `docs/terminal-flood-detect.mjs` (Issue #173; upstream [#2094](https://github.com/ComposioHQ/agent-orchestrator/issues/2094)) |
| Review-ready false stuck guard | `docs/review-ready-stuck-guard.mjs` (Issue #174; rules in prompts + example YAML) |
| Recovery when stuck | [`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md) |
| Wake wiring | [`orchestrator-wake-runbook.md`](orchestrator-wake-runbook.md) |

## Every session — two operator processes (plus optional watcher)

**Terminal A — AO**

```powershell
cd <orchestrator-pack-root>
ao start orchestrator-pack
```

**Terminal B — side-process supervisor** (preferred — Issues #168, #202, #205)

Starts the nine side-processes in
`scripts/orchestrator-side-process-registry.json` as separate managed children:
review-trigger reconcile/reeval, ready-report seed, CI-green and CI-failure reconcile,
worker-message submit, review-start claim reaper, dead-worker reconcile, and escalation-router.
The retired listener, heartbeat, review-send reconcile, and four PR-A vestigial children are not
started. The supervisor resolves the orchestrator session id for session-bound children, restarts
registered children on exit or stall, and debounces confirmed session-id changes. Logs:
`%LOCALAPPDATA%/orchestrator-pack-wake-supervisor/` (Linux:
`$XDG_STATE_HOME/orchestrator-pack-wake-supervisor/`).

```powershell
cd <orchestrator-pack-root>
# Optional: pin session id instead of auto-resolve from ao status
# $env:AO_ORCHESTRATOR_SESSION_ID = 'op-orchestrator'
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
```

Status and stop:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
```

Optional env (safe defaults when unset): `AO_WAKE_SUPERVISOR_WAIT_SECONDS` (default
120 — bounded wait for orchestrator session before exit), `AO_WAKE_SUPERVISOR_POLL_SECONDS`
(supervisor poll, default 5), `AO_WAKE_SUPERVISOR_STATE_DIR`, `AO_WAKE_SUPERVISOR_PROJECT_ID`
(default `orchestrator-pack`). See [`orchestrator-wake-runbook.md`](orchestrator-wake-runbook.md).

**Manual fallback — per-process launches** (when debugging one path in isolation):

- Escalation router: `scripts/orchestrator-escalation-router.ps1 -Once` with
  `AO_ORCHESTRATOR_SESSION_ID` set when testing orchestrator-facing delivery.
- Review-trigger reconcile: `scripts/review-trigger-reconcile.ps1` (default 10 min).
- CI-green wake: `scripts/ci-green-wake-reconcile.ps1` (default 1 min).
- Worker message submit: `scripts/worker-message-submit-reconcile.ps1` (default 30 s).

Each supports `-Once -DryRun` for fixture/contract checks without live `ao`/`gh`.

**Terminal E — worktree trust watcher** (Windows Cursor; avoids blocking
`Workspace Trust Required` on each new `op-*` worktree)

```powershell
cd <orchestrator-pack-root>
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-worktree-trust-watcher.ps1
```

One-shot trust for an existing session worktree:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/trust-ao-worktree.ps1 -SessionId op-35
```

Verify:

```powershell
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
pwsh -NoProfile -File scripts/check-vestigial-fleet-children-retired.ps1 -Json
```

Expect the nine-child registry roster and no listener/heartbeat process. Trust watcher should log
`trusted: ...\worktrees\op-*` when a worker spawns.

## Live config (`agent-orchestrator.yaml`, gitignored)

AO 0.10.2 ProjectConfig and native `AGENTS.md` pickup remain authoritative. The retired loopback
listener does not require `notifiers.webhook`, `notificationRouting`, port 17487, or a repository
YAML edit. During operator cleanup, remove local webhook routing that existed only for that
listener.

Keep worker permissions, reviewer command configuration, pack `scripts/` PATH adoption, and
worktree trust setup aligned with the current ProjectConfig. Restart the side-process supervisor
after registry or harness changes:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Stop
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-supervisor.ps1 -Action Start
```

## How the loop is supposed to run

```text
worker PR/report/CI state
    → periodic registry children reconcile current GitHub + AO state
    → review-trigger-reconcile / review-trigger-reeval / ready-report seed
    → ao-review run <worker> when the exact head is eligible and uncovered
    → changes_requested + auto-delivery → worker addressing_reviews → …
```

**Gaps operators hit:**

- Ready-for-review metadata alone does not create a webhook turn. Coverage now comes from the
  surviving script-side reconcile/seed/reeval children, not listener or heartbeat paths.
- Orchestrator `stuck` / `probe_failure` — no shell actions run; use
  [recovery runbook](orchestrator-recovery-runbook.md) step 1 before kill/restart.

## Verification (pass / fail)

| Check | Command / signal | Pass |
|-------|------------------|------|
| Fleet status | `orchestrator-wake-supervisor.ps1 -Action Status` | Nine registry children healthy |
| Listener retired | `check-vestigial-fleet-children-retired.ps1 -Json` | `status: pass` |
| Orchestrator alive | `ao status` | Not `stuck` / `probe_failure` on orchestrator row |
| Review started | `Get-AoReviewRuns` / `ao-review list <session> --json` | New run after worker `ready_for_review` |
| Command correct | `latestRun.body` (failure detail) on failed runs | Names wrapper matching `PACK_REVIEWER` (`run-pack-review.ps1` or `run-pack-review-claude.ps1`), not bare `review.ps1` alone |
| Strict gate (operator) | `pwsh -File scripts/orchestrator-diagnose.ps1 -Strict` | Exit 0 before human merge when AO is running |
| Harness guard | `pwsh -File scripts/check-ao-0-10-review-trigger.ps1` | Exit 0 |
| Vocabulary guard | `pwsh -File scripts/check-review-010-vocabulary.ps1` | Exit 0 |

## Troubleshooting routing

| Symptom | Open |
|---------|------|
| Retired child appears in status | Stop the supervisor, remove identity-matched old-generation processes, and restart from the updated checkout |
| Orchestrator `stuck`, zero review runs | [Recovery runbook](orchestrator-recovery-runbook.md) step 1 ping |
| Review runs `failed`, `findingCount: 0` (empty failed review) | `.\scripts\orchestrator-diagnose.ps1 -Strict`; [migration_notes.md](migration_notes.md) § Issue #60 empty-review trap; [reviewer-switch-runbook.md](reviewer-switch-runbook.md) if Codex quota |
| Change reviewer (Codex / Sonnet) | [reviewer-switch-runbook.md](reviewer-switch-runbook.md) |
| Worker dies in ~1 min, no PR | [migration_notes.md](migration_notes.md) § Issue #63 |

## Related issues

- [#68](https://github.com/chetwerikoff/orchestrator-pack/issues/68) — this checklist in-repo
- [#163](https://github.com/chetwerikoff/orchestrator-pack/issues/163) — `review-trigger-reconcile.ps1` (state-derived review trigger)
- [#59](https://github.com/chetwerikoff/orchestrator-pack/issues/59) — heartbeat backstop (`orchestrator-wake-heartbeat.ps1`)
- [#623](https://github.com/chetwerikoff/orchestrator-pack/issues/623) — AO 0.10 review harness + trigger loop
- [#625](https://github.com/chetwerikoff/orchestrator-pack/issues/625) — review vocabulary migration
