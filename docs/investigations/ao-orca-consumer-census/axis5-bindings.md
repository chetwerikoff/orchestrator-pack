# Axis 5 — lifecycle and recovery assumption bindings

Inspected revision: `afd99fb7bc5f4fcb210005d96b56db7d3064a45f` after #1248 landed at `cb765cb3a2c225581b1d350a292abfa0fa7fe2bf`.

**Unit:** consumer path × canonical surface ID × axis 5. Retired command patterns are owned by `scripts/json-producers/retired-surfaces.json`; current-head path classification is owned by `scripts/ao-retirement/retired-surface-inventory.json`.

| Consumer path | Canonical surface ID | Class | Evidence |
|---|---|---|---|
| `scripts/lib/Invoke-AoCliJson.ps1` | `daemon.health` | **port** | Remaining AO service health adapter, explicitly deferred. |
| `AGENTS.md` | `session.get` | **port** | AO-managed workers still verify live session identity at pickup. |
| `AGENTS.md` | `daemon.lifecycle` | **port** | Managed workers remain forbidden from restarting the runtime. |
| `docs/orchestrator-recovery-runbook.md` | `session.lifecycle` | **port** | AO operator recovery remains an explicitly deferred active-service surface. |
| `scripts/wait-orchestrator-launch.ps1` | `session.get` | **port** | AO launch/session wait remains an explicitly deferred service caller. |
| `.claude/skills/change-orchestrator-runtime/SKILL.md` | `daemon.lifecycle` | **port** | Runtime-change adoption remains outside this cut. |
| `docs/orchestrator-recovery-runbook.md` | `report.status-embed` | **shed** | Retired status/report vocabulary remains bounded deferred debt. |
| `docs/orchestrator-recovery-runbook.md` | `report.worker-state` | **shed** | Retired report vocabulary remains bounded deferred debt. |
| `docs/orchestrator-recovery-runbook.md` | `review.project-list` | **shed** | Retired project review-list vocabulary remains bounded deferred debt. |

Removed stale rows:

- `scripts/lib/Orchestrator-SideProcessHealth.ps1` is absent from current tracked production paths after the #1248 runtime hard cut.
- `scripts/set-pack-reviewer.ps1` is absent; reviewer selection is now the pack-owned TypeScript preference CLI.
- `.claude/skills/merge-with-local-adoption/SKILL.md` uses Orca and explicitly declares AO retired, so it no longer owns AO lifecycle recovery.

**Binding rows:** 9
