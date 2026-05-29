# Implement ao-scope-guard runtime

GitHub Issue: #5

## Prerequisite

Issue #3 — Architecture decisions (file `docs/issues_drafts/00-architecture-decisions.md`) must be merged. This issue implements
guard layers 1 and 2 from #3.C and consumes the declaration mirror written by
#4.

## Goal

Implement DD-024 equivalent through the three-layer model from #3.C. This
issue covers layers 1 (agent wrapper) and 2 (pre-commit hook). Layer 3 (CI
PR diff) is #6.

## Binding surface

Three layers per #3.C:

1. **Agent wrapper — primary first defense.** Wraps the AO agent invocation
   (cursor / codex CLI). After each agent turn, diffs the working tree
   against the declared scope and refuses to proceed on violations.
2. **Pre-commit hook — secondary local backstop.** Installed via
   `scripts/install-git-hooks.ps1` in the target repo. Blocks commit creation
   when staged paths violate scope. Pre-commit alone is not the first line
   of defense: it runs after `git add` and only catches the index, not the
   working tree.
3. CI PR diff check is **out of scope here** and lives in #6.

Reason: the wrapper covers working-tree mutations before any git command runs;
the hook covers staged state right before the commit object is created.
Together they bracket the local danger window.

## Files in scope

- `plugins/ao-scope-guard/lib/check.ts` (new) — allow ∩ deny logic against active scope; consumes `_shared/normalize`
- `plugins/ao-scope-guard/lib/diff_worktree.ts` (new) — list working-tree changes since baseline
- `plugins/ao-scope-guard/lib/diff_index.ts` (new) — list staged paths from index
- `plugins/ao-scope-guard/bin/scope-check.ts` (new) — CLI invoked by the hook and by the wrapper
- `plugins/ao-scope-guard/bin/agent-wrap.ts` (new) — wraps cursor/codex invocation; runs scope-check after each agent turn
- `plugins/ao-scope-guard/hooks/pre-commit` (new) — POSIX bash hook
- `plugins/ao-scope-guard/hooks/pre-commit.ps1` (new) — PowerShell hook for Windows
- `plugins/ao-scope-guard/package.json` (new)
- `plugins/ao-scope-guard/README.md` — append installation + wrapper usage
- `scripts/install-git-hooks.ps1` — extend optionally to install scope-guard hook into a target repo (not into pack itself)

## Files out of scope

- AO core, `vendor/agent-orchestrator/**`
- `plugins/ao-task-declaration/**` — consumed via declaration mirror in `.ao/declarations/` from #4
- `plugins/_shared/**` — depends on the #4 published shape only; this issue does not edit `_shared`
- Other plugin directories

## Denylist

- `vendor/**`
- `packages/core/**`
- `.ao/**`
- secrets

## Acceptance criteria

- `scope-check` CLI loads the current declaration from `.ao/declarations/` mirror; falls back to regenerating it from `docs/declarations/{issue_number}.{iteration_id}.json` per #3.A.
- Refuses to proceed if no mirror and no snapshot exist for the current iteration **unless** the current change set consists entirely of control artifacts (see exclusion list below).
- `--mode index` enumerates staged paths via `git diff --cached --name-only` (used by pre-commit).
- `--mode worktree` enumerates working-tree mutations since baseline `commit_sha` (used by wrapper).
- **Control artifact exclusion** (hardcoded, not user-configurable):
  - `docs/declarations/**` — committed snapshots
  - `.ao/**` — gitignored runtime state
  These paths are always allowed and are never reported as out-of-scope.
- **Pure control-artifact commit policy:** if every path in a change set lies under the exclusion list, scope check exits 0 even when no active declaration exists. This makes the declaration commit itself possible.
- **Mixed commit policy:** when a change set contains both control-artifact paths and other paths, control-artifact paths are skipped; the remaining paths are validated against the active declaration. No active declaration → reject.
- Normalizes every path through `_shared/normalize`; rejects out-of-scope or denylisted paths among non-control entries.
- Exit code 1 plus structured violation report on rejection.
- Pre-commit hook installation is opt-in, idempotent, and reversible.
- Hook blocks the commit; it does not destructively reset files.
- Agent wrapper runs scope-check after each agent turn; refuses to spawn the next agent action on violation.
- README documents install, bypass-with-justification, uninstall, wrapper invocation, and the control-artifact exclusion.

## Upgrade-safety check

- `git ls-files | rg -e '^(packages/core|vendor/)'` returns nothing.
- Hook runs without AO present; depends only on `.ao/declarations/` and git.
- `npm install -g @aoagents/ao` continues to work without conflicts.
- No AO YAML changes.

## Verification

- Unit tests cover normalization edge cases (`..`, drive letters, symlinks, mixed slashes, UNC paths).
- Integration test: synthetic repo with declaration; attempt commits inside and outside scope.
- `./scripts/verify.ps1` still passes.
