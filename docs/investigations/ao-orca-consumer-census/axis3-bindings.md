# Axis 3 — worker-facing behavioral text bindings

Inspected revision: `afd99fb7bc5f4fcb210005d96b56db7d3064a45f` after #1248 landed at `cb765cb3a2c225581b1d350a292abfa0fa7fe2bf`.

**Unit:** consumer path × canonical surface ID × axis 3. Retired command patterns are owned by `scripts/json-producers/retired-surfaces.json`; current-head path classification is owned by `scripts/ao-retirement/retired-surface-inventory.json`.

| Consumer path | Canonical surface ID | Class | Evidence |
|---|---|---|---|
| `AGENTS.md` | `session.get` | **port** | AO-managed worker first-action verification remains active. |
| `AGENTS.md` | `daemon.lifecycle` | **port** | Managed workers remain forbidden from runtime restart operations. |
| `AGENTS.md` | `pack.worker-report` | **port** | Pack report command remains the worker handoff surface. |
| `AGENTS.md` | `plugin.review-command` | **port** | Pack review runner / reviewer command remains active. |
| `plugins/ao-codex-pr-reviewer/README.md` | `plugin.review-command` | **port** | Exact preserved pack-owned review plugin contract. |
| `docs/orchestrator-recovery-runbook.md` | `session.lifecycle` | **port** | AO operator recovery remains an explicitly deferred active-service surface. |
| `docs/orchestrator-recovery-runbook.md` | `daemon.health` | **port** | AO health assumptions remain an explicitly deferred active-service surface. |
| `.claude/skills/change-orchestrator-runtime/SKILL.md` | `daemon.lifecycle` | **port** | Runtime-change operator adoption remains outside this cut. |
| `prompts/investigate_root_cause.md` | `report.status-embed` | **shed** | Retired status/report vocabulary remains bounded deferred debt in the RCA contract. |
| `prompts/investigate_root_cause.md` | `report.worker-state` | **shed** | Retired report examples remain bounded deferred debt in the RCA contract. |
| `agent-orchestrator.yaml.example` | `report.worker-state` | **shed** | Legacy report wording remains bounded inside the active AO config migration surface. |
| `CLAUDE.md` | `spawn.worker` | **port** | Architect delegation remains an active AO service concern outside this cut. |

Removed stale rows:

- `.claude/skills/switch-pack-reviewer/SKILL.md` no longer calls or instructs `ao review list`; it now uses the pack-owned reviewer preference CLI.
- `.claude/skills/merge-with-local-adoption/SKILL.md` now declares AO retired and uses Orca for lifecycle cleanup; it no longer owns an AO `session.lifecycle` binding.

**Binding rows:** 12
