# AO → Orca migration PR0: consumer census workspace

**Issue:** [#1036](https://github.com/chetwerikoff/orchestrator-pack/issues/1036)  
**Wave:** PR0 (record-only)  
**Inspected revision:** `8fabf182f4df0a70e2f08f67899658ee886ab337` (2026-07-28, `main` ancestry via `chetwerikoff/implement-issue-1036`)

This directory holds the two PR0 deliverables:

| Deliverable | File |
|---|---|
| Closed-world AO consumer census | [`census.md`](./census.md) |
| Zero-consumer checklist contract | [`zero-consumer-checklist.md`](./zero-consumer-checklist.md) |

Supporting reference (representation map extracted for checklist reuse):

| Reference | File |
|---|---|
| Canonical AO surface identities + representation map | [`surface-identity-map.md`](./surface-identity-map.md) |
| Per-token `AO_*` axis-2 bindings (273 rows) | [`ao-env-token-inventory.md`](./ao-env-token-inventory.md) |

## Record-only boundary

PR0 changes **documentation under this subtree only**. It does not modify runtime behavior, durable state, worker policy, workflows, scripts, or required checks.

## Downstream consumption (documentation obligation)

| Wave | Relationship |
|---|---|
| **PR1** | **Exempt** — dead-cut scope is files already unreachable from every supported live root; PR0 zero-consumer verdict is not a PR1 gate. |
| **PR7** | Must cite a **true** zero-consumer result (per surface in scope) as deletion-readiness evidence. |
| **PR8** | Same as PR7 for its scoped surfaces. |

## Quick reproduction

From a clean checkout at the inspected revision:

```bash
export REV=8fabf182f4df0a70e2f08f67899658ee886ab337
git checkout "$REV"

# Axis 1 — CLI-shaped AO use (production scripts/plugins/docs + config example)
grep -rE '\bao (status|session|orchestrator|send|spawn|stop|start|events|review|report)\b' \
  scripts plugins docs AGENTS.md CLAUDE.md prompts .claude .cursor agent-orchestrator.yaml.example \
  --include='*.ps1' --include='*.ts' --include='*.mjs' --include='*.md' --include='*.yaml*' \
  | grep -v '/tests/' | grep -v '/fixtures/' | grep -v 'docs/investigations/' | wc -l

# Axis 1 — command-config only (orchestratorRules example)
grep -nE '\bao (status|session|send|spawn|stop|start|events|review|report)\b' agent-orchestrator.yaml.example

# Axis 1 — direct daemon HTTP paths
grep -rE '/api/v1/(projects|sessions)' scripts docs --include='*.ps1' --include='*.mjs' --include='*.ts'

# Axis 2 — tracked AO_* names (wildcard-fragment filter)
grep -rhoE 'AO_[A-Z0-9_]+' scripts plugins docs AGENTS.md CLAUDE.md prompts \
  .claude .cursor agent-orchestrator.yaml.example package.json .github 2>/dev/null \
  | grep -vE '_$' | sort -u | tee /tmp/ao-tokens.txt | wc -l

# Axis 3 — worker-facing normative AO text (primary pass)
grep -lE '\bao (session|spawn|send|stop|start|review|report)\b' AGENTS.md CLAUDE.md prompts/*.md docs/*runbook*.md agent-orchestrator.yaml.example

# Axis 3 — independent cross-check (skills mirror)
grep -lE '\bao (session|spawn|send|stop|start|review|report)\b' .claude/skills/*/SKILL.md .cursor/skills/*/SKILL.md

# Axis 4 — durable stores (authoritative inventory)
node -e "console.log(require('./scripts/vitest-live-store-inventory.json').stores.map(s=>s.id).join('\n'))"

# Axis 4 — independent cross-check (sessionId persistence in contracts)
grep -l 'sessionId' docs/worker-report-store.mjs docs/pr-session-binding-cache.mjs docs/worker-status-store.mjs 2>/dev/null

# Axis 5 — lifecycle assumptions (primary)
grep -lE 'ao (stop|start|restart)|daemon.*health|session (kill|restore)' docs/orchestrator-recovery-runbook.md AGENTS.md

# Axis 5 — independent cross-check (implementation guards)
grep -lE 'ao (stop|start|restart)|Get-AoDaemonHealthJson' scripts/lib/*.ps1 scripts/*.ps1
```

Full accounting rules, completeness arguments, binding tables, and classifications are in [`census.md`](./census.md). The zero-consumer verdict function is in [`zero-consumer-checklist.md`](./zero-consumer-checklist.md).
