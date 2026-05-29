# Autonomous review loop — operator go-live

One checklist to turn on the review loop that is **already implemented** in this
repo (Issues #28 / #39 / #60 — merged as PRs #42, #47, #65). AO does **not** run
Codex review when a worker spawns; the **orchestrator** drives
`ao review run` → `ao review send` → worker `addressing_reviews` → re-review.

Follow-ups [#58](https://github.com/chetwerikoff/orchestrator-pack/issues/58)
(reconciliation via `gh` open PRs) and
[#59](https://github.com/chetwerikoff/orchestrator-pack/issues/59) (heartbeat
backstop) add resilience; this doc covers the shipped baseline.

## What is already in the repo

| Capability | Where |
|------------|--------|
| Autonomous loop rules | `agent-orchestrator.yaml.example` → `orchestratorRules` |
| Worker review contract | `prompts/agent_rules.md` |
| Pack review command | `scripts/run-pack-review.ps1` (**REVIEW_COMMAND** / **PACK_REVIEW_SHELL**) |
| Switch Codex ↔ Claude Sonnet | [`reviewer-switch-runbook.md`](reviewer-switch-runbook.md) |
| Wake listener | `scripts/orchestrator-wake-listener.ps1`, `docs/orchestrator-wake-filter.mjs` |
| Recovery when stuck | [`orchestrator-recovery-runbook.md`](orchestrator-recovery-runbook.md) |
| Wake wiring | [`orchestrator-wake-runbook.md`](orchestrator-wake-runbook.md) |

## Every session — three processes

**Terminal A — AO**

```powershell
cd <orchestrator-pack-root>
ao start orchestrator-pack
```

**Terminal B — wake listener** (before or with `ao start`)

```powershell
cd <orchestrator-pack-root>
$env:AO_ORCHESTRATOR_SESSION_ID = 'op-orchestrator'   # your id from ao status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/orchestrator-wake-listener.ps1
```

**Terminal C — worktree trust watcher** (Windows Cursor; avoids blocking
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
Test-NetConnection -ComputerName 127.0.0.1 -Port 17487
```

Expect listener log: `listening`. On wake events expect `accepted: <kind>` — not
only `dropped: not_wake_relevant`. Trust watcher should log `trusted: ...\worktrees\op-*`
when a worker spawns.

## Live config (`agent-orchestrator.yaml`, gitignored)

1. Diff your live file against `agent-orchestrator.yaml.example` for:
   - `projects.<id>.orchestratorRules` (full block, including **COMMAND DISCIPLINE**)
   - top-level `reactions` (especially `report-stale`)
   - `notifiers.webhook` and `notificationRouting` (`urgent` / `action` → `webhook`)
2. **Cursor worker permissions** — under `projects.<id>.orchestrator` and `.worker`,
   set `agentConfig.permissions: permissionless` so AO passes `--force --sandbox disabled`
   to the Cursor CLI (see example YAML). Set `~/.cursor/cli-config.json`
   `approvalMode` to `unrestricted` (not `allowlist`). Run the worktree trust watcher
   above — AO worktrees are new paths each spawn and still need headless `--trust` once.
   Do not add a broken `.cursor/cli.json` in this repo; project-level overrides must
   match the Cursor CLI schema or `agent` refuses to start.

3. **Required reaction fix** — without this, CI-green / mergeable does not reach the webhook:

   ```yaml
   approved-and-green:
     auto: false
     action: notify
     priority: action
   ```

   A partial override without `priority` sends notifications desktop-only; the wake
   listener never sees `merge.ready`.

4. **Review command at shell time only** — copy from rules (**REVIEW_COMMAND** or
   **PACK_REVIEW_SHELL**), e.g.:

   ```powershell
   ao review run <worker-session-id> --execute --command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-pack-review.ps1 --repo-root . --base origin/main"
   ```

   Forbidden: bare `plugins/ao-codex-pr-reviewer/bin/review.ps1`, `cmd /c npm ci && …`,
   `ao review run --execute` without `--command`.

5. Reload prompts and rules:

   ```powershell
   ao stop
   ao start orchestrator-pack
   ```

## How the loop is supposed to run

```text
worker: pr_created / ready_for_review (+ CI green)
    → AO notification (action) → webhook → listener → ao send orchestrator
    → orchestrator turn: ao review list, ao status --reports full
    → ao review run <worker> --execute --command "<REVIEW_COMMAND>"
    → needs_triage → ao review send → worker addressing_reviews → …
```

**Gaps operators hit:**

- `ao report ready_for_review` updates metadata only — it does **not** POST a
  wake webhook by itself. You need mergeable/merge.ready routing (above) or an
  orchestrator turn from wake / recovery ping / #59 heartbeat.
- Orchestrator `stuck` / `probe_failure` — no shell actions run; use
  [recovery runbook](orchestrator-recovery-runbook.md) step 1 before kill/restart.

## Verification (pass / fail)

| Check | Command / signal | Pass |
|-------|------------------|------|
| Listener up | `Test-NetConnection 127.0.0.1 -Port 17487` | `TcpTestSucceeded : True` |
| Synthetic wake | POST from [wake runbook](orchestrator-wake-runbook.md) | Log: `accepted: …` |
| Orchestrator alive | `ao status` | Not `stuck` / `probe_failure` on orchestrator row |
| Review started | `ao review list <project> --json` | New run after worker `ready_for_review` |
| Command correct | `terminationReason` on failed runs | Contains `run-pack-review.ps1`, not bare `review.ps1` alone |

## Troubleshooting routing

| Symptom | Open |
|---------|------|
| Listener only `dropped: not_wake_relevant` | This doc § live config (`approved-and-green.priority`); [wake runbook](orchestrator-wake-runbook.md) |
| Orchestrator `stuck`, zero review runs | [Recovery runbook](orchestrator-recovery-runbook.md) step 1 ping |
| Review runs `failed`, `findingCount: 0` (empty failed review) | `.\scripts\orchestrator-diagnose.ps1`; [migration_notes.md](migration_notes.md) § Issue #60 empty-review trap; [reviewer-switch-runbook.md](reviewer-switch-runbook.md) if Codex quota |
| Change reviewer (Codex / Sonnet) | [reviewer-switch-runbook.md](reviewer-switch-runbook.md) |
| Worker dies in ~1 min, no PR | [migration_notes.md](migration_notes.md) § Issue #63 |

## Optional until #59

Low-frequency `ao send` to the orchestrator (e.g. Task Scheduler every 15–20 min)
is an interim backstop when the webhook path is quiet. Durable heartbeat is Issue
#59; event-only wake from #39 is already production.

## Related issues

- [#68](https://github.com/chetwerikoff/orchestrator-pack/issues/68) — this checklist in-repo
- [#58](https://github.com/chetwerikoff/orchestrator-pack/issues/58) — `gh` reconciliation in rules
- [#59](https://github.com/chetwerikoff/orchestrator-pack/issues/59) — heartbeat backstop
