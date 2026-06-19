# Worker delegation policy in agent rules

GitHub Issue: #215

## Prerequisite

- `docs/first_principles_5_operational_framework.md` — cost rule and “cheapest sufficient executor”
  ladder already documented; this issue **references** that doc, it does not duplicate the full
  framework in `agent_rules.md`.
- `docs/issues_drafts/32-worker-acknowledge-pickup-contract.md` (GitHub #88) — closed; pickup
  (`ao acknowledge`) remains the mandatory first action **before** any delegated exploration.

## Goal

AO Cursor workers waste tokens and time when they either spawn subagents for trivial lookups or
carry large multi-area exploration inline. Add a **Delegation policy** section to universal worker
rules so every session uses the same cost-aware, scope-safe boundaries for when to delegate
(parallel exploration, bounded research) versus when to act directly (single-path edits, deterministic
tools, declared-scope implementation).

## Binding surface

- `prompts/agent_rules.md` gains a **Delegation policy** section that is readable without opening
  other files for the core do/don't rules, but **links** to
  `docs/first_principles_5_operational_framework.md` for the full cost ladder (no copy-paste of the
  entire framework — shared-source-of-truth discipline).
- Rules apply to any in-session delegation mechanism the agent runtime exposes (e.g. subagent / Task
  tool launches). The section states what delegated helpers **may** and **must not** do relative to
  the worker’s active declaration and AO reporting contract.
- If `prompts/agent_rules_spawn_stub.md` remains the Windows spawn entry, it either repeats the
  one-line “follow delegation policy in worktree rules after acknowledge” pointer or stays
  consistent with how other sections are stubbed today — planner picks the minimal consistent
  approach.
- No AO core, vendor, or `agent-orchestrator.yaml` schema changes. No new model providers or
  routing config — policy text only.

## Files in scope

- `prompts/agent_rules.md`
- `prompts/agent_rules_spawn_stub.md` (only if still referenced for spawn)

## Files out of scope

- `vendor/**`, `packages/core/**`
- `agent-orchestrator.yaml`, `agent-orchestrator.yaml.example`
- Orchestrator `orchestratorRules` / `reactions` text
- Model-routing scripts, provider API wiring, or CI for external models
- `docs/first_principles_5_operational_framework.md` (reference only unless a one-line pointer fix
  is needed — not a rewrite)
- `.claude/skills/**`, `CLAUDE.md` (architect-side)

```denylist
vendor/**
packages/core/**
packages/**
.github/workflows/**
scripts/**
plugins/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
docs/first_principles_5_operational_framework.md
.claude/**
```

```allowed-roots
prompts/**
```

## Acceptance criteria

1. **Section present.** `prompts/agent_rules.md` contains a **Delegation policy** heading with
   worker-facing rules (not architect-only prose).
2. **Cheapest executor first.** The section requires deterministic/repo tools (search, read, shell
   checks, tests) **before** launching LLM subagents for the same information-gathering goal, and
   points to `docs/first_principles_5_operational_framework.md` for the broader cost ladder without
   pasting ≥10 consecutive lines from that file (self-architect duplicate-literal guard).
3. **When delegation is appropriate.** The section names at least two **valid** delegation patterns
   (e.g. parallel exploration of disjoint codebase areas; bounded read-only research the worker will
   synthesize) and at least two **invalid** patterns (e.g. delegating commits/PR/`ao report` work;
   delegating a single obvious grep/read; delegating scope amendments or declaration changes).
4. **Scope and accountability.** Delegated helpers must stay inside the worker’s active declared
   scope; the worker remains accountable for merged edits, verification, and AO status transitions —
   subagents do not run `ao-declare`, `ao report`, or open PRs on their own.
5. **Parallelism discipline.** When parallel subagents are used, the section requires independent
   subtasks (no duplicate exploration of the same path) and a cap mindset (prefer one focused helper
   over a fan-out when the task is narrow).
6. **Escalation, not infinite delegation.** If delegation does not unblock progress within reasonable
   effort, the worker must stop spawning helpers and either fix inline, `ao send` with evidence, or
   report terminal failure — not recurse subagents indefinitely.
7. **Stub consistency (if applicable).** When `agent_rules_spawn_stub.md` exists and is referenced
   for spawn, a reader can find delegation policy via stub + worktree rules without contradiction.
8. `pwsh -NoProfile -File scripts/verify.ps1` passes on the PR head.

## Upgrade-safety check

- Pack-only prompt text; no AO core or vendor edits.
- No new secrets, env vars, or workflow triggers.
- Preserves planner freedom for wording and section placement beyond the contract above.
- Does not mandate a specific subagent runtime API shape or model tier names.

## Verification

```powershell
Select-String -Pattern 'Delegation policy|delegat' prompts/agent_rules.md
if (Test-Path prompts/agent_rules_spawn_stub.md) {
  Select-String -Pattern 'delegat|agent_rules\.md' prompts/agent_rules_spawn_stub.md
}
pwsh -NoProfile -File scripts/verify.ps1
pwsh -NoProfile -File scripts/lint-self-architect.ps1 -Strict
```

Manual (optional): on a scoped open issue, observe a worker session that uses one bounded subagent
for multi-file discovery, then implements inline — no subagent commits and no `ao report` from
helpers.
