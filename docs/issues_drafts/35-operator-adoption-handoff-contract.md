# Operator adoption handoff contract

GitHub Issue: #101

## Prerequisite

- `docs/issues_drafts/26-orchestrator-autoloop-go-live.md` (GitHub #68) — canonical operator go-live checklist; this issue adds the **cross-task handoff contract**, not a second go-live doc.
- `docs/issues_drafts/22-issue-draft-github-numbering.md` (GitHub #57) — draft ↔ GitHub registry discipline.

No hard dependency on open implementation issues. Tasks that already ship operator adoption prose in
`docs/migration_notes.md` remain valid; this issue makes the contract **uniform and enforceable**.

## Goal

After a worker PR merges, operator-facing settings (live AO YAML, long-running listeners, env vars,
`ao stop`/`ao start`, machine-local CLI config) are often documented but **not executed**, so the
pack silently regresses until someone re-reads scattered docs. This issue defines **who documents,
who executes, and when**, plus lightweight guards so adoption steps are not lost between merge and
the next spawn.

Observed failure mode: PR changes `agent-orchestrator.yaml.example` and `docs/migration_notes.md`,
Codex and CI pass, merge happens — operator never merges live yaml or restarts the wake listener;
the next worker spawn runs against stale wiring.

## Binding surface

The repository MUST commit to a **three-role adoption contract**:

| Role | Responsibility | Timing |
|------|----------------|--------|
| **Architect (issue spec)** | When a task touches operator-facing surfaces, the draft includes an **Operator adoption** subsection under Binding surface listing post-PR steps the operator must run (yaml merge, processes, env, restart, verification). | Before implementation starts. |
| **Worker** | Before reporting successful completion: add the same checklist to the PR body under `## Operator adoption` (near the top, under `## Summary`) and add or update a matching subsection in `docs/migration_notes.md`. Workers **document** adoption; they do **not** treat listener startup, secrets, or live yaml merge as done unless the operator confirms. | PR ready (verification green, review clean). |
| **Operator (human)** | Execute the checklist after merge (or before local end-to-end test). Owns gitignored config and long-running processes. | After PR merge. |

**Operator-facing surfaces** (triggers the contract when changed or introduced):

- `agent-orchestrator.yaml.example` (any block operators must mirror into live yaml)
- Runbooks or go-live docs that introduce **new operator processes** (listeners, watchers, schedulers)
- Documented operator env vars (`PACK_REVIEWER`, `AO_ORCHESTRATOR_SESSION_ID`, etc.)
- Machine-local config outside the repo (called out explicitly; worker cannot commit it)
- `orchestratorRules` or `reactions` changes that require `ao stop` / `ao start` to take effect

**Worker rules (`prompts/agent_rules.md`).** Add a short **Operator adoption handoff** section:

- Require the PR + `migration_notes` checklist when the task touches operator-facing surfaces.
- Forbid reporting `completed` while the PR lacks `## Operator adoption` when `.example` or
  operator-process docs changed in scope.
- State explicitly that workers MUST NOT assume adoption is done: no obligation to start listeners,
  edit secrets, or merge live yaml from an AO worktree (worktree copies are not the operator
  checkout).
- Optional helper only: if the worker session runs in the **primary pack checkout** (not an
  `op-*` worktree) and the operator asks in the issue, the worker MAY merge `.example` deltas
  into live yaml and note that in the PR — still not a substitute for the operator checklist.

**Issue authoring (`.claude/skills/create-issue-draft/SKILL.md`).** Extend the fixed draft structure
with an optional **Operator adoption** bullet under Binding surface: required when the task's
Files in scope include operator-facing surfaces above; otherwise omit.

**Canonical doc pointer (`docs/migration_notes.md`).** Add a subsection **Operator adoption contract**
with the role table, link to [`docs/orchestrator-autoloop-go-live.md`](../orchestrator-autoloop-go-live.md)
as the umbrella checklist, and one sentence on waiver semantics (below).

**Orchestrator reminder (`agent-orchestrator.yaml.example`).** Extend `orchestratorRules` with
quote-safe prose: when a PR is merge-ready / mergeable, the orchestrator's next turn MUST remind
the operator to execute the **Operator adoption** section from that PR (and `migration_notes`) before
assuming the loop is fully live. No embedded double-quote characters in the literal (Issue #55).

**CI guard (PR-time).** When a PR diff includes `agent-orchestrator.yaml.example`, the PR MUST also
change `docs/migration_notes.md` **or** the PR body MUST contain this exact waiver line on its own:

```text
No operator adoption required
```

Waiver is for cosmetic-only `.example` edits with zero operator follow-up; misuse should fail review.
The guard runs in CI alongside existing pack checks (planner picks script name and wiring).

**Out of contract scope (explicit).** Workers do not own: starting `orchestrator-wake-listener.ps1`,
trust watcher terminals, Task Scheduler heartbeat (#59), or writing `~/.cursor/cli-config.json`.
Those remain operator steps documented in checklists.

## Files in scope

- `prompts/agent_rules.md` — worker handoff section (document, not execute)
- `docs/migration_notes.md` — operator adoption contract subsection
- `docs/orchestrator-autoloop-go-live.md` — cross-link to contract (no duplicate prose)
- `agent-orchestrator.yaml.example` — orchestratorRules operator-reminder clause only
- `.claude/skills/create-issue-draft/SKILL.md` — draft structure extension
- `scripts/**` — new or extended PR/local guard for `.example` ↔ `migration_notes` pairing
- `scripts/verify.ps1` and/or `.github/workflows/scope-guard.yml` — invoke the guard where appropriate
- `docs/issues_drafts/00-architecture-decisions.md` — decision log entry (§M)
- `docs/issues_drafts/35-operator-adoption-handoff-contract.md` — this spec

## Files out of scope

- `vendor/**`, `packages/core/**`, AO upstream
- Live `agent-orchestrator.yaml` (gitignored; operator-owned)
- Retroactive rewrite of every closed issue draft
- Automatic yaml merge or listener startup by workers
- Heartbeat implementation (Issue #59) or full `gh` reconciliation prose (Issue #58)

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
agent-orchestrator.yaml
```

```allowed-roots
prompts/**
docs/**
scripts/**
agent-orchestrator.yaml.example
.claude/skills/create-issue-draft/**
.github/workflows/**
```

## Acceptance criteria

1. **`prompts/agent_rules.md`** contains an **Operator adoption handoff** section that (a) requires
   `## Operator adoption` in the PR and a `migration_notes` subsection when operator-facing surfaces
   change, (b) forbids silent `completed` when that section is missing for such tasks, (c) states
   workers do not start listeners or merge live yaml by default, (d) allows optional live-yaml help
   only in the primary checkout when the issue asks for it.
2. **`docs/migration_notes.md`** has an **Operator adoption contract** subsection with the role
   table and a link to the go-live doc.
3. **`.claude/skills/create-issue-draft/SKILL.md`** documents when drafts MUST include Operator
   adoption under Binding surface.
4. **`agent-orchestrator.yaml.example`** `orchestratorRules` includes quote-safe operator-reminder
   prose for merge-ready PRs; `scripts/check-orchestrator-rules-quotes.ps1` still passes.
5. **CI guard:** A PR that changes `agent-orchestrator.yaml.example` fails the new check unless
   `docs/migration_notes.md` is also in the diff or the PR body contains the exact waiver line
   `No operator adoption required`.
6. **Go-live cross-link:** `docs/orchestrator-autoloop-go-live.md` links to the migration_notes
   contract subsection in one sentence (no duplicated role table).
7. **`docs/issues_drafts/00-architecture-decisions.md`** records decision **§M** consistent with this
   contract.

## Upgrade-safety check

- Pack-only prompts, docs, scripts, and example YAML; no AO core or vendor edits.
- No new secrets; orchestratorRules remain double-quote-free (Issue #55).
- Waiver line is exact-match to avoid ambiguous CI skips.
- Preserves planner freedom for guard script shape and workflow wiring.

## Verification

```powershell
Select-String -Pattern 'Operator adoption' prompts/agent_rules.md, docs/migration_notes.md
Select-String -Pattern 'Operator adoption' .claude/skills/create-issue-draft/SKILL.md
.\scripts\check-orchestrator-rules-quotes.ps1
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

**Guard fixture (manual or automated):**

1. On a branch that changes only a comment in `agent-orchestrator.yaml.example` with PR body waiver
   `No operator adoption required` — guard passes.
2. On a branch that changes an operator-facing key in `.example` without `migration_notes.md` and
   without waiver — guard fails.
3. On a branch that changes `.example` and adds a matching `migration_notes` subsection — guard passes.

**Static — orchestrator reminder:** `Select-String -Pattern 'Operator adoption|operator adoption' agent-orchestrator.yaml.example` matches the new rules clause; quote check passes.

**Pre-sync note:** Codex draft review was not run (CLI usage limit, 2026-05-30). Re-run the skill review pass before the next edit to this draft.
