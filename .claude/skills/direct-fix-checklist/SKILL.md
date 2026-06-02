---
name: direct-fix-checklist
description: Use when the user explicitly authorizes the architect to open a direct PR that edits tracked files (not gitignored local config). Skip for normal work — spawn an AO worker instead — and skip for gitignored-only changes (agent-orchestrator.yaml, .ao/) that need no PR scope guard.
---

# direct-fix-checklist

Authorized override when the user explicitly asks the architect to land a
direct PR. Architect role context: `CLAUDE.md` (default is worker spawn;
this skill is the only supported bypass).

## When to invoke

- User clearly authorizes **this PR** to be an architect-direct edit (e.g.
  "fix it yourself", "open a PR for this doc change now").
- The change must touch tracked files that CI scope-guard enforces.

## When to skip

- Normal queue work → spawn `ao spawn` / let the planner declare and implement.
- Gitignored-only edits (`agent-orchestrator.yaml`, `.ao/**`) with no tracked diff.
- User has not named a specific authorized direct PR.

## CI checks the PR must pass

From `.github/workflows/scope-guard.yml` (job `name` fields):

| Job name | What it runs |
|----------|----------------|
| **Verify orchestrator-pack structure** | `./scripts/verify.ps1`, `./scripts/check-reusable.ps1` |
| **PR scope guard** | `scripts/pr-scope-check.ps1` (trusted base copy + PR head diff vs declaration snapshot + issue fences) |
| **Run pack contract tests** | `npm ci`, `tsc`, `./scripts/test-all.ps1` |
| **Self-architect lint** | `./scripts/lint-self-architect.ps1 -Strict` (PRs only) |

All four must be green before merge. AO does **not** auto-run Codex review on
architect-direct PRs — run manual review (below).

## PR body issue reference

**Implementation** direct PRs **must** include a closing reference the scope
guard parses:

- `Closes #N`, `Fixes #N`, or `Resolves #N` (case-insensitive, `#` required).

**Spec-only docs** direct PRs (draft publish to `main`) use the lighter path
documented in [`docs/repository_policy.md`](../../../docs/repository_policy.md#spec-only-docs-prs):
`<!-- pr-type: spec-only -->` plus a non-closing `Refs #N` (no snapshot, issue
stays open). Do not use closing keywords on spec-only PRs.

## Declaration snapshot

- **Path:** `docs/declarations/<issue_number>.<iteration_id>.json`
- **Owner:** `ao-task-declaration` plugin via `ao-declare` — never hand-edit or forge JSON.
- **Iteration id:** comes from `AO_SESSION_ID` under AO (e.g. issue #6 →
  `6.op-4.json`, **not** `6.6.json`). Read the real id from `ao status` or the
  snapshot filename after declare — do not assume `op-<issue-number>`.

### Obtain a snapshot without a full worker implementation

1. Spawn a worker scoped to declaration only, then claim or reuse its session:
   ```powershell
   ao spawn --issue <N>   # planner declares; worker may stop after snapshot
   ao status              # note session id (e.g. op-4)
   ```
2. Or, on a clean worktree with the issue already on GitHub:
   ```powershell
   $env:AO_ISSUE_NUMBER = '<N>'
   $env:AO_SESSION_ID = 'op-<your-session>'   # if not already set by AO
   npx ao-declare --issue <N> `
     --declared-paths path/one.ts,path/two.md `
     --declared-globs 'plugins/foo/**'
   ```
   Flags (only these exist on `plugins/ao-task-declaration/bin/declare.ts`):
   `--issue`, `--declared-paths`, `--declared-globs`, `--iteration-id`,
   `--amend`, `--reason`, `--actor`, `--repo-root`.

3. Commit **only** the snapshot (plus in-scope edits):
   ```powershell
   git add docs/declarations/<N>.<iteration_id>.json
   ```

Amend once per iteration if scope must change: `ao-declare --amend --reason "..."`.

## Pre-push local self-check

From repository root:

```powershell
.\scripts\verify.ps1
.\scripts\test-all.ps1
```

Fix failures before push — do not use CI as the first scope check.

## Manual Codex review (direct PRs)

AO auto-review runs on **worker** PRs only. For architect-direct PRs, run the
pack reviewer wrapper locally after the PR exists (or against the branch diff):

```powershell
# Replace <session> with worker session id if reusing one; else use --issue + --pr-number
node --import tsx plugins/ao-codex-pr-reviewer/bin/review.ts `
  --repo-root . `
  --base origin/main `
  --issue <N> `
  --pr-number <pr>
```

**Clean vs findings** (contract in `docs/issues_drafts/06-codex-reviewer-scope-context.md`, Issue #9):

| Trimmed stdout | Meaning |
|----------------|---------|
| Exactly `NO_FINDINGS` | Clean — zero findings; safe to merge after CI |
| JSON `{"findings":[...]}` | Actionable findings — fix or rebut before merge |
| Empty stdout | **Not** clean — wrapper/run failed |
| Prose like "No concrete bugs…" | **Not** clean — forbidden narration |

Treat P0/P1 before merge; P2 may be tracked in the issue if accepted.

## Pivot back to worker flow

Stop the direct path and spawn a worker when:

- Scope grows beyond what you declared (needs `--amend` twice or new iteration).
- Implementation touches plugins/scripts/tests you did not declare.
- Codex or scope-guard reports repeated scope violations.
- User did not actually authorize a direct PR.

```powershell
ao status                    # read real session id
ao session kill <session-id> # only if abandoning a stuck worker
ao spawn --issue <N>
```

Do **not** kill a session using `op-<issue-number>` unless `ao status` shows that id.

## Don't

- Forge or hand-edit `docs/declarations/*.json`.
- Use the `scope-guard-degraded` label to bypass snapshot requirements.
- Merge with `gh pr merge --admin` to skip review or failing checks.
- Put `declared_paths` in the issue body — only `denylist` / `allowed-roots` fences + snapshot.
- Invent `ao-declare` flags (`--paths`, `--globs`, etc.) — use `--declared-paths` / `--declared-globs`.
