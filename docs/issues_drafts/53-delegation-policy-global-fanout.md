# Global delegation-policy fan-out across agent entrypoints

GitHub Issue: #149

## Prerequisite

- `docs/issues_drafts/52-coworker-cli-delegation-policy.md` (GitHub #148) — defines the **canonical**
  Coworker CLI delegation policy in `prompts/agent_rules.md`. This issue does **not** restate or edit
  that policy; it only makes the canonical section reachable from other entrypoints. Land after #148
  so the pointer targets a section that exists.
- New architecture decision **§S** in
  `docs/issues_drafts/00-architecture-decisions.md` (next free letter — §R is reserved by the RTK
  draft `51-coworker-rtk-worker-adaptation.md` / #145).

## Goal

The coworker delegation policy reaches only AO-injected Cursor workers, because it lives in
`prompts/agent_rules.md`, which AO feeds via `agentRulesFile`. Three other entrypoints never see it:
**standalone Cursor CLI** (no AO injection), **Codex**, and **Claude Code** (reads `CLAUDE.md`). Make
the policy effective from every entrypoint by keeping **one canonical copy** and adding **thin
pointers** from each tool's native rules surface — no content duplication, so the policy cannot drift.

## Binding surface

- **Single source of truth stays `prompts/agent_rules.md`.** The delegation policy text (triggers,
  profiles, anti-delegation, reviewer carve-out, provider-input fence) is authored and maintained
  only there (#148). This issue adds **references**, never a second copy.
- **Pointer from each native entrypoint** (unconditional — one per tool, so coverage does not depend
  on uncertain native behavior):
  - `AGENTS.md` — read natively by **Codex** (and any Cursor version that loads it).
  - `.cursor/rules/` (new, always-applied rule) — the guaranteed surface for **standalone Cursor**
    CLI sessions; Cursor auto-loads an always-applied project rule, so this does not rely on whether
    Cursor reads `AGENTS.md`.
  - `CLAUDE.md` — the architect (**Claude Code**) entrypoint.
  Each pointer is a short directive that **names the canonical location** (`prompts/agent_rules.md`)
  and resolves a reader to it; it must not paste the policy body.
- **No duplicate-literal violation.** No pointer may copy **10 or more consecutive lines** of the
  canonical policy (self-architect duplicate-literal guard). Pointers summarize intent in ≤ a few
  lines and link/name the source.
- **Correct the stale scope claim in `CLAUDE.md`.** Its header (currently “Cursor and Codex read
  `prompts/agent_rules.md` and the issue body”) asserts native reading that holds **only under AO
  injection**. Qualify it to direct each tool to its surface: Codex → `AGENTS.md`; standalone Cursor →
  `.cursor/rules`; AO-injected agents → `prompts/agent_rules.md`. The claim lives in `CLAUDE.md` (in
  scope) — not in the denied `prompts/agent_rules.md`. Planner picks replacement wording.
- **Architecture decision §S** records: delegation policy is single-sourced in `agent_rules.md` and
  surfaced via one pointer per entrypoint — AO `agentRulesFile` (workers), `AGENTS.md` (Codex),
  `.cursor/rules` (standalone Cursor), `CLAUDE.md` (architect); **enforcement** remains advisory
  (review/operator are the backstop, no hook mandates delegation) even though the read-delegation
  **obligation** is mandatory per §S.3 / #148 — obligation and enforcement are separate axes.
- No AO core, vendor, or `agent-orchestrator.yaml` changes; no change to the policy content itself.

## Files in scope

- `AGENTS.md`
- `CLAUDE.md`
- `.cursor/rules/` (new always-applied rule file — planner names it)
- `docs/issues_drafts/00-architecture-decisions.md` (new §S)
- `docs/issue_queue_index.md` (registry row)

## Files out of scope

- `prompts/agent_rules.md` — canonical policy content lives in #148; this issue does not edit it.
- `agent-orchestrator.yaml` / `agent-orchestrator.yaml.example` — no AO wiring change.
- Enforcement hooks (`beforeShellExecution`, Claude Code hooks) — delegation stays advisory.
- `vendor/**`, `packages/core/**`, `plugins/**`, `scripts/**`, `.github/workflows/**`.

```denylist
vendor/**
packages/core/**
plugins/**
scripts/**
.github/workflows/**
agent-orchestrator.yaml
agent-orchestrator.yaml.example
prompts/agent_rules.md
```

```allowed-roots
AGENTS.md
CLAUDE.md
.cursor/rules/**
docs/issues_drafts/00-architecture-decisions.md
docs/issue_queue_index.md
```

## Acceptance criteria

1. **AGENTS.md pointer.** `AGENTS.md` contains a directive that names the canonical coworker
   delegation policy in `prompts/agent_rules.md` and resolves a reader to it.
2. **CLAUDE.md pointer.** `CLAUDE.md` contains an equivalent pointer to the same canonical section.
3. **Direct-Cursor coverage.** A new **always-applied** `.cursor/rules/` rule names
   `prompts/agent_rules.md` and resolves a reader to it (an always-applied project rule is loaded by
   Cursor in every session, so coverage does not depend on `AGENTS.md` native behavior).
4. **No duplication.** No added pointer copies ≥ 10 consecutive lines of the canonical policy;
   `scripts/lint-self-architect.ps1 -Strict` passes.
5. **Stale-claim corrected (`CLAUDE.md` header).** The `CLAUDE.md` header no longer implies non-AO
   Cursor/Codex read `prompts/agent_rules.md` without qualification — it directs Codex to `AGENTS.md`
   and standalone Cursor to `.cursor/rules` (no blanket claim that `AGENTS.md` is universally native).
6. **Architecture decision §S present** in `00-architecture-decisions.md` and synced to the live
   architecture issue (#3) in the same PR; cross-linked from the pointers or §S.
7. **Single source preserved.** `prompts/agent_rules.md` remains the only file carrying the full
   policy body (no second authoritative copy introduced).
8. **Registry row.** `docs/issue_queue_index.md` has a row mapping
   `53-delegation-policy-global-fanout.md` to its GitHub issue with an accurate one-line summary.

## Upgrade-safety check

- No edits under `vendor/**` or AO `packages/core/**`; no `agent-orchestrator.yaml` schema use.
- No new repo secrets.
- Policy content is not duplicated — pointers only; canonical source remains `prompts/agent_rules.md`.
- No unsupported YAML in tracked config examples (none touched).

## Verification

```powershell
# Pointers must NAME prompts/agent_rules.md AND carry the new coworker-delegation directive.
# (The bare path already pre-exists in the CLAUDE.md header, so also require the 'coworker' token
#  to prove a NEW pointer was added rather than the stale line passing vacuously.)
if (-not (Select-String -Path AGENTS.md -Pattern 'prompts/agent_rules\.md' -Quiet) -or `
    -not (Select-String -Path AGENTS.md -Pattern '(?i)coworker' -Quiet)) { throw 'AGENTS.md coworker pointer missing' }
if (-not (Select-String -Path CLAUDE.md -Pattern 'prompts/agent_rules\.md' -Quiet) -or `
    -not (Select-String -Path CLAUDE.md -Pattern '(?i)coworker' -Quiet)) { throw 'CLAUDE.md coworker pointer missing' }
# Stale claim corrected: CLAUDE.md now routes Codex -> AGENTS.md and standalone Cursor -> .cursor/rules
if (-not (Select-String -Path CLAUDE.md -Pattern 'AGENTS\.md' -Quiet) -or `
    -not (Select-String -Path CLAUDE.md -Pattern '\.cursor/rules' -Quiet)) { throw 'CLAUDE.md stale scope claim not corrected' }
# Standalone Cursor: a .cursor/rules file that is BOTH always-applied (alwaysApply: true) AND names
# the canonical path — both conditions in the same file, so a non-always rule cannot pass.
$cursorRule = if (Test-Path .cursor/rules) {
  Get-ChildItem .cursor/rules -File -Recurse | Where-Object {
    (Select-String -Path $_.FullName -Pattern 'prompts/agent_rules\.md' -Quiet) -and
    (Select-String -Path $_.FullName -Pattern 'alwaysApply:\s*true' -Quiet)
  }
} else { @() }
if (-not $cursorRule) { throw '.cursor/rules always-applied delegation pointer missing' }
# Architecture decision §S recorded
if (-not (Select-String -Path docs/issues_drafts/00-architecture-decisions.md -Pattern '## S\.' -Quiet)) { throw 'arch decision S missing' }
# Registry row present
if (-not (Select-String -Path docs/issue_queue_index.md -Pattern '53-delegation-policy-global-fanout' -Quiet)) { throw 'registry row missing' }
# Guards green
pwsh -NoProfile -File scripts/lint-self-architect.ps1 -Strict
pwsh -NoProfile -File scripts/verify.ps1
```

`AGENTS.md` also covers Codex (native). No manual session step is required — the `.cursor/rules`
always-applied rule is the deterministic standalone-Cursor surface.

**Open question (recorded at the 5-iteration draft-review cap):** the token assertions above are a
*necessary screen*, not full proof that each pointer is a genuine reader-facing directive (a prose
pointer cannot be fully proven by grep, and the canonical path pre-exists in the `CLAUDE.md` header).
The Codex **PR review** is the backstop that confirms AC #1/#2/#5 are real directives in the right
place — consistent with the cost rule (tests + review as the safety net). If a stricter machine check
is wanted later, add an anchored marker convention in a follow-up rather than over-prescribing wording
here.
