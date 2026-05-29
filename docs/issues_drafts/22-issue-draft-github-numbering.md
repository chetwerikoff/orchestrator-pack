# Issue queue index — one registry mapping draft files to GitHub Issue numbers

GitHub Issue: #57

## Prerequisite

None. Documentation and architect-process hygiene. Does not block other
implementation work; land early so RCA and queue reviews stop mis-labeling
shipped work as "planned."

**5 Whys (failure trace, 2026-05-28):**

1. An architect RCA listed draft work as "planned" when the corresponding
   GitHub Issues were already closed/shipped.
2. The author cited `docs/issues_drafts/NN-….md` file prefixes as if they were
   GitHub Issue numbers.
3. The two numbering schemes do not line up: e.g. draft
   `19-codex-review-finding-bar.md` maps to GitHub **#51**, while GitHub **#19**
   is an unrelated task (Auto-fix loop convergence metrics, which descends
   from draft `09-…`). Several draft prefixes (`14`–`18`) have **no** GitHub
   Issue at that number at all — the numbers simply don't exist as issues.
4. The real GitHub numbers live in scattered `GitHub Issue:` header lines, and
   only some drafts record them.
5. Root cause: no single registry resolving draft file → GitHub Issue, and no
   agent procedure requiring that resolution before making a status claim.

## Goal

Establish **one canonical registry** mapping each draft file to its GitHub
Issue number, and a procedure that forbids inferring "shipped" or "planned"
from a draft filename. The registry stores the stable mapping only; **live
issue state stays authoritative in GitHub** (queried via `gh`), never copied
into and re-synced across markdown files. Referencing queue work uses either
the **draft path** (stable) or a **GitHub `#number` resolved from the
registry**, never a bare `NN` whose scheme is ambiguous.

Implemented registry: [`docs/issue_queue_index.md`](../issue_queue_index.md).

## Binding surface

1. **Single registry (new).** One file is the authoritative map from each
   `docs/issues_drafts/NN-<slug>.md` (excluding `00-architecture-decisions.md`)
   to its GitHub Issue number (or "none yet"). The registry MUST:
   - cover every current draft file;
   - carry a short **How to reference work** legend distinguishing the draft
     filename prefix from the GitHub `#` (with at least one concrete colliding
     example from the 2026-05-28 RCA, e.g. draft `19-…` → GitHub #51, not #19);
   - state that **live status is read from `gh issue view <N> --json state`**,
     not stored in the registry, and not inferred from a draft file existing.

   The registry stores the *stable identifiers* (draft path ↔ GitHub number)
   and optional one-line notes. It does **not** carry a per-issue status column
   to keep in sync; GitHub is the source of truth for open/closed/shipped.

2. **Per-draft header (minimal change).** Where a draft already records its
   GitHub number, the convention stays the existing single `GitHub Issue: #NN`
   line. Drafts that have a GitHub Issue but omit the line get the line added.
   No new mandatory table, no reformatting of drafts that already comply. A
   draft with no GitHub Issue yet uses `GitHub Issue: TBD`.

3. **Architect procedures updated:**
   - The root-cause investigation procedure (`prompts/investigate_root_cause.md`)
     must require consulting the registry and running `gh issue view` for live
     state before listing any task as "planned" or "shipped", and must forbid
     deriving that status from the presence of a draft file alone.
   - The `create-issue-draft` skill must require adding/updating the draft's row
     in the registry when a draft is created or first synced, and require
     prerequisite references to use the **draft file path** (stable) plus the
     GitHub number from the registry when known.

4. **Discovery pointers** — a one-line pointer to the registry under
   `CLAUDE.md` "Sources of truth" and in the `docs/architecture.md` task-queue
   section. An optional one-line pointer in `AGENTS.md`.

5. **No renumbering.** Draft filename prefixes and GitHub Issue numbers are not
   realigned. The registry documents the mapping; renaming files or issues is
   out of scope.

## Files in scope

- A new registry file under `docs/` (planner picks the exact filename).
- `docs/issues_drafts/*.md` — only to add a missing `GitHub Issue:` line where
  the draft has a known GitHub Issue; no bulk reformat.
- `docs/issues_drafts/22-issue-draft-github-numbering.md` — this spec.
- `prompts/investigate_root_cause.md` — planned/shipped resolution procedure.
- `.claude/skills/create-issue-draft/SKILL.md` — registry-update step on sync.
- `CLAUDE.md` — pointer under Sources of truth.
- `docs/architecture.md` — pointer to the registry.
- `AGENTS.md` — optional one-line pointer.
- `docs/migration_notes.md` — short note for operators/architects.

## Files out of scope

- `packages/core/**`, `vendor/**`, AO runtime.
- Renaming or renumbering `docs/issues_drafts/NN-*.md` files.
- Closing/reopening GitHub Issues, or creating GitHub Issues for historical
  drafts (registry maps what exists; backfill of new issues is out of scope).
- Any per-draft status field or mandatory metadata table.
- `agent-orchestrator.yaml` / `agent-orchestrator.yaml.example`.

## Denylist

```denylist
vendor/**
packages/core/**
.ao/**
.agent-orchestrator/**
agent-orchestrator.yaml
plugins/**
.github/workflows/**
scripts/pr-scope-check.ps1
scripts/pr-scope-check.ts
scripts/pr-scope-check.test.ts
prompts/codex_review_prompt.md
prompts/agent_rules.md
```

```allowed-roots
docs/**
prompts/investigate_root_cause.md
.claude/skills/create-issue-draft/**
CLAUDE.md
AGENTS.md
```

## Acceptance criteria

- **Registry exists** with (a) a usage legend disambiguating draft prefix vs
  GitHub `#`, including at least one concrete colliding example from the
  2026-05-28 RCA, and (b) a row for every `docs/issues_drafts/*.md` except
  `00-architecture-decisions.md`, mapping draft path → GitHub Issue number (or
  an explicit "none yet").
- **No stored status** — the registry contains no open/closed/shipped column;
  it states that live state comes from `gh issue view`.
- **Per-draft line present where applicable** — every draft that has a known
  GitHub Issue carries a `GitHub Issue: #NN` line; drafts without one carry
  `GitHub Issue: TBD`. No draft is reformatted beyond adding/normalizing that
  single line.
- **RCA procedure updated** — `investigate_root_cause.md` forbids "planned"/
  "shipped" claims from draft-file existence alone and requires the registry
  plus `gh issue view`.
- **create-issue-draft skill updated** — requires updating the registry row on
  draft create/sync.
- **Pointers present** — `CLAUDE.md` and `docs/architecture.md` link to the
  registry.
- **Verification commands pass** — `.\scripts\verify.ps1` and
  `.\scripts\check-reusable.ps1`.

## Upgrade-safety check

- Documentation and skill text only; no AO core, vendor, plugin, or CI edits.
- No new repo secrets or CI gates. If the planner adds an optional registry
  validator it MUST be read-only (file parse / `gh issue view`) and listed in
  Verification.

## Verification

1. Open the registry — legend with a colliding example and a row per draft
   file are present; no status column.
2. Spot-check known mappings against live GitHub state:
   - `14-orchestrator-wake-mechanism.md` → GitHub **#39** (`gh issue view 39
     --json state` → CLOSED).
   - `15-orchestrator-recovery-runbook.md` → GitHub **#40** (CLOSED).
   - `17-patch-review-loop-sentfindingcount.md` → GitHub **#45** (CLOSED).
   - `19-codex-review-finding-bar.md` → GitHub **#51**; confirm GitHub **#19**
     is the unrelated "Auto-fix loop convergence" task, demonstrating the
     collision the registry warns about.
3. Confirm each draft with a known GitHub Issue has a `GitHub Issue: #NN` line
   and no other draft was reformatted.
4. Read `prompts/investigate_root_cause.md` and
   `.claude/skills/create-issue-draft/SKILL.md` for the updated procedures.
5. `.\scripts\verify.ps1` and `.\scripts\check-reusable.ps1`.
