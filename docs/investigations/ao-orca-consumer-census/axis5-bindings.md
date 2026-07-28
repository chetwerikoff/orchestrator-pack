# Axis 5 — lifecycle and recovery assumption bindings

Inspected revision: `8fabf182f4df0a70e2f08f67899658ee886ab337`

**Unit:** consumer path × canonical surface ID × axis 5. Summary table in [`census.md`](./census.md) §5.5 is derived from this inventory.

| Consumer path | Canonical surface ID | Class | Evidence |
|---|---|---|---|
| `scripts/lib/Orchestrator-SideProcessHealth.ps1` | `daemon.health` | **port** | Side-process ticks require live daemon |
| `scripts/lib/Invoke-AoCliJson.ps1` | `daemon.health` | **port** | Health probe adapter |
| `AGENTS.md` | `session.get` | **port** | Workers verify session within 60s of start |
| `AGENTS.md` | `daemon.lifecycle` | **port** | Managed workers must not restart daemon |
| `docs/orchestrator-recovery-runbook.md` | `session.lifecycle` | **port** | Prefer `session kill` + `restore` over full daemon cycle |
| `scripts/wait-orchestrator-launch.ps1` | `session.get` | **port** | Orchestrator launch / session wait |
| `scripts/set-pack-reviewer.ps1` | `daemon.lifecycle` | **port** | Operator `ao stop` / `ao start` for reviewer switch |
| `.claude/skills/change-orchestrator-runtime/SKILL.md` | `daemon.lifecycle` | **port** | Operator yaml/rules adoption restart |
| `.claude/skills/merge-with-local-adoption/SKILL.md` | `session.lifecycle` | **port** | Session recycle after runtime-sensitive merge |
| `docs/orchestrator-recovery-runbook.md` | `report.status-embed` | **shed** | Retired `ao status --reports` ack path |
| `docs/orchestrator-recovery-runbook.md` | `report.worker-state` | **shed** | Retired `ao report` ack path |
| `docs/orchestrator-recovery-runbook.md` | `review.project-list` | **shed** | Retired `ao review list` board assumption |

**Binding rows:** 12
