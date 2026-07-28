# Axis 3 — worker-facing behavioral text bindings

Inspected revision: `dcda4ed83ffb9027948607860bcdd5276abb2752`

**Unit:** consumer path × canonical surface ID × axis 3. Summary table in [`census.md`](./census.md) §5.3 is derived from this inventory.

| Consumer path | Canonical surface ID | Class | Evidence |
|---|---|---|---|
| `AGENTS.md` | `session.get` | **port** | First-action `ao session get` within 60s |
| `AGENTS.md` | `daemon.lifecycle` | **port** | Forbid `ao stop/start/restart` in managed workers |
| `AGENTS.md` | `pack.worker-report` | **port** | Worker handoff replaces `ao report` |
| `AGENTS.md` | `plugin.review-command` | **port** | `REVIEW_COMMAND` / pack review path |
| `plugins/ao-codex-pr-reviewer/README.md` | `plugin.review-command` | **port** | Review subprocess contract |
| `docs/orchestrator-recovery-runbook.md` | `session.lifecycle` | **port** | `session kill` / `restore` recovery |
| `docs/orchestrator-recovery-runbook.md` | `daemon.health` | **port** | Daemon health assumptions |
| `.claude/skills/merge-with-local-adoption/SKILL.md` | `session.lifecycle` | **port** | Post-merge session recycle |
| `.claude/skills/change-orchestrator-runtime/SKILL.md` | `daemon.lifecycle` | **port** | Operator AO restart for rules adoption |
| `.claude/skills/switch-pack-reviewer/SKILL.md` | `review.project-list` | **shed** | Retired `ao review list` text |
| `docs/orchestrator-recovery-runbook.md` | `review.project-list` | **shed** | Retired project-wide review list text |
| `prompts/investigate_root_cause.md` | `report.status-embed` | **shed** | Retired `ao status --reports` instruction |
| `prompts/investigate_root_cause.md` | `report.worker-state` | **shed** | Retired `ao report` instruction |
| `agent-orchestrator.yaml.example` | `report.worker-state` | **shed** | Legacy `ao report` ack lines in orchestratorRules |
| `CLAUDE.md` | `spawn.worker` | **port** | Architect `ao spawn` worker delegation |

**Binding rows:** 15
