---
name: direct-fix-checklist
description: Use when the user explicitly authorizes the architect to open a direct PR that edits tracked files. Skip for normal queue work — the default is to hand the change to a worker — and skip for gitignored-only local config edits that produce no tracked diff and need no PR scope guard.
---

# direct-fix-checklist

Authorized override when the user explicitly asks the architect to land a
direct PR. Architect role context: `CLAUDE.md` (default is handing the change
to a worker; this skill is the only supported bypass).

## When to invoke

- User authorizes **this specific change, for this one direct-PR run** (e.g.
  "fix it yourself", "open a PR for this doc change now"). The PR does not have
  to exist yet — authorization is per change, not per PR number.
- The change touches tracked files that the CI scope guard enforces.

## When to skip

- Normal queue work → hand the change to a worker (§ Hand off to a worker).
- Gitignored-only edits that leave the tracked diff empty — no PR, no scope guard.
- The user asked for implementation generally, without authorizing the architect
  to be the one who writes it.

## The direct-PR spine

Run these in order. The sections below expand the numbered steps.

1. **Confirm authorization** covers this change (§ When to invoke).
2. **Open or identify the issue.** Implementation PRs need one; note its number `N`.
3. **Work off a clean base.** Never commit from a shared checkout you did not
   verify: confirm the current branch, and check whether another session has
   uncommitted work in it. If the checkout is shared or dirty, create a separate
   worktree from `origin/main` and do everything there.
4. **Branch** from `origin/main`.
5. **Edit** only the paths you intend to declare.
6. **Inspect the diff** — `git diff --name-only origin/main..HEAD` must list
   exactly your paths and nothing else. Anything unexpected means you branched
   off someone else's work; rebuild the branch before continuing.
7. **Commit the edits** — the declaration producer needs a clean tree.
8. **Produce the declaration snapshot** (§ Declaration snapshot).
9. **Commit the snapshot.**
10. **Pre-push self-check** (§ Pre-push local self-check).
11. **Push**, then **open the PR** with the right body contract (§ PR body issue
    reference).
12. **Read the PR back** — confirm it exists, targets `main`, and its diff is
    what you pushed.

## Declaration snapshot

- **Path:** `docs/declarations/<issue_number>.pr-scope.json` — no iteration or
  session id in the filename. Older files in that directory use the retired
  `<issue>.<iteration_id>.json` form; the guard discovers `<issue>.*.json`, but
  only a valid current-schema declaration resolves — a legacy-schema payload is
  rejected fail-closed. Produce a new snapshot; never revive an old one.
- **Owner:** `scripts/pr-scope-declaration.ts` — never hand-edit or forge the JSON.
- **No worker, no session, no runtime needed.** The producer is standalone.

**Prerequisite:** the repository's own `scripts/gh` wrapper must exist and its
GitHub transport must work — the producer executes `<repo-root>/scripts/gh`
directly to read the issue body and parse its `allowed_roots` / `denylist`
fences. It resolves the wrapper by path, so the wrapper does **not** need to be
on `PATH`. Pass `--issue-body-file <file>` to skip the lookup entirely.

The issue body **must** contain a fenced `denylist` block, or the producer
refuses to run. An `allowed-roots` fence is optional and narrows the repository
ceiling when present.

```bash
node --experimental-strip-types scripts/pr-scope-declaration.ts \
  --issue <N> \
  --declared-paths path/one.ts,path/two.md \
  --declared-prefixes 'plugins/foo/**'
```

Canonical flags: `--issue`, `--declared-paths`, `--declared-prefixes`,
`--issue-body-file`, `--repo-root`, `--output`. `--declared-globs` is a
deprecated alias for `--declared-prefixes`; `--amend` is a compatibility spelling
that only prints a notice. Unknown arguments are rejected, so do not invent
flags. At least one of paths/prefixes is required, and any `--output` must stay
under `docs/declarations/`.

Stage the snapshot **together with the edited paths**, then re-read what is
staged before committing — staging the snapshot alone produces a
declaration-only commit and leaves the actual fix behind:

```bash
git add docs/declarations/<N>.pr-scope.json path/one.ts path/two.md
git diff --cached --name-only
```

**Scope changed ⇒ re-run the producer.** There is no amendment budget and no
once-per-iteration rule.

## PR body issue reference

**Implementation** direct PRs **must** include a closing reference the scope
guard parses:

- `Closes #N`, `Fixes #N`, or `Resolves #N` (case-insensitive, `#` required).

**Spec-only docs** direct PRs use the lighter path documented in
[`docs/repository_policy.md`](../../../docs/repository_policy.md#spec-only-docs-prs):
`<!-- pr-type: spec-only -->` alone on one line plus a non-closing `Refs #N` (no
snapshot, issue stays open). That path covers `docs/issues_drafts/**`,
`docs/issue_queue_index.md`, and `.claude/skills/**/*.md`. Do not use closing
keywords on spec-only PRs.

**Check the allowlist before choosing.** A single path outside the markdown
union — `CLAUDE.md`, `scripts/**`, `.github/**` — drops the whole PR back to the
implementation path, snapshot and closing keyword included.

## Pre-push local self-check

From the repository root:

```powershell
.\scripts\verify.ps1
.\scripts\test-all.ps1
```

**Fix only failures your diff caused.** When a failure looks unrelated, re-run
the same check on a clean `origin/main` worktree. If it reproduces there it is
pre-existing: report it, and do not touch unrelated files to make it green —
that is scope creep the guard will reject. Do not use CI as the first scope check.

## CI checks the PR must pass

The authority is the **required checks reported for the PR's current head**, not
this list — read them from the PR rather than trusting prose that can go stale.
As of writing, `.github/workflows/scope-guard.yml` contributes: change
classification, repository-structure verification, the PR scope guard,
type-checking, Vitest light and heavy lanes with their topology planner, Pester
regression, a fail-closed contract-test aggregate, and self-architect lint.

**The scope guard runs from the trusted _base_ checkout, not your branch.** A fix
to the guard itself does not take effect on the PR that introduces it.

## PR review (operator-initiated only)

**Never self-initiate a review** — architectural or PR, on any engine. Opening
the PR does not authorize starting one. The user decides when a review runs.

When the operator orders a review, run the pack-owned runner **from the trusted
pack checkout**, never from the reviewed worktree:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n>
```

Optional head pin: `--head-sha <40-hex>`. Status: `... list`. `--session-id` is
for worker PRs; a direct architect PR needs only `--pr-number`.

The reviewer engine is selected by the `PACK_REVIEWER` env var (`codex | claude |
gpt`), resolved in `scripts/lib/resolve-pack-reviewer.ts` and bound into the
reviewer child by the runner. To change it, use the `switch-pack-reviewer` skill —
do not invoke a reviewer plugin directly; the runner owns claim, cap, head
binding, and is the sole GitHub publisher.

Merging requires an operator-requested pack review at the **current head** from
the configured `PACK_REVIEWER`. The requirement is the review, not any one engine.

**Verdict contract** — the runner needs a valid verdict JSON object, either as
the whole stdout or on one parseable non-empty line (it scans lines in reverse
and takes the first valid payload):

| Reviewer stdout | Meaning |
|-----------------|---------|
| `{"verdict":"clean","findingCount":0,"findings":[]}` | Clean — safe to merge after CI |
| `{"verdict":"findings",...}` with matching `findingCount` | Actionable findings — fix or rebut before merge |
| Empty stdout | **Not** clean — the run failed |
| Prose narration ("No concrete bugs…") | **Not** clean — no valid verdict payload |
| `NO_FINDINGS` sentinel | **Not** clean — the runner does not recognize it |

`findingCount` must equal `findings.length` or the runner hard-errors. Treat
P0/P1 before merge; P2 may be tracked in the issue if accepted.

**Not for issue drafts:** architect spec review uses `codex review` or
`scripts/review-architect-artifact.ts` — see the `create-issue-draft` skill.

## Hand off to a worker

### Runtime profile (the ONLY runtime-specific surface)

**What this table does and does not deliver.** It centralizes the vendor commands
so they live in one place instead of scattered through the steps. It does **not**
by itself deliver runtime portability: the capability set below is shaped like the
active runtime's worktree/terminal model, so a runtime built on a different
lifecycle (remote jobs, containers, no persistent terminals) needs the steps
rewritten, not just this column. The durable fix is an executable seam over
`selectRuntimeAdapter`, which does not exist yet. Vocabulary is kept identical to
`merge-with-local-adoption` so the two skills do not drift apart.

**Before any effect, confirm the active runtime matches this table's header.**
Read the authoritative selection (`OPK_RUNTIME_ADAPTER`, default `orca`) rather
than assuming an installed binary is the selected runtime — a leftover vendor CLI
will otherwise succeed against the wrong fleet, silently.

| Capability | Active runtime = `orca` |
|---|---|
| `RUNTIME.workspace_for(issue)` | `orca worktree create --name <name> --repo "path:<repo-root>" --base-branch origin/main --issue <N> --setup skip --activate` |
| `RUNTIME.spawn_worker(wt)` | `orca terminal create --worktree "path:<wt>" --title "<role> #<N>" --command "<agent-cli> --model <model>" --focus` |
| `RUNTIME.agents` | `orca worktree ps --json` → `result.worktrees[].agents[]` (`state`, `interrupted`) |
| `RUNTIME.terminals(wt)` | `orca terminal list --worktree "path:<wt>" --json` → `result.terminals[]` (`handle`, `worktreePath`) |
| `RUNTIME.stop_terminals(wt)` | `orca terminal stop --worktree "path:<wt>" --json` |

Left-column names are identifiers, not commands — only the mapped right-hand
command is executable. Postconditions the mapping must preserve on any runtime:
the workspace is created from `origin/main` and bound to the issue; the worker is
**visible to the operator**; the agent starts **as part of creating its session**,
with its model passed explicitly — never typed into a shell afterwards.

**Resolve every placeholder before acting, and fail closed if you cannot:**
`<N>` = the issue number from spine step 2; `<repo-root>` = the repository root;
`<name>` = a workspace name naming the issue; `<role>` = what the worker is for;
`<agent-cli>` and `<model>` = the worker agent and model the operator's standing
routing prescribes — if that is unstated, **ask**, do not guess; `<wt>` = the
workspace path returned by `RUNTIME.workspace_for`.

**Fail closed.** If the active runtime has no row for a capability a step needs,
or a placeholder has no authoritative value, **stop and report blocked**. Never
improvise a substitute command, and never fall back to the direct path because
the handoff was inconvenient. The blocked report must name: the active runtime,
the missing capability or value, the last step completed, the current
branch/PR/head state, and confirmation that no substitute command was run.

### When to pivot

Stop the direct path and hand the change over when:

- Scope grows so the declared scope no longer matches the diff.
- Implementation touches plugins/scripts/tests you did not declare.
- The reviewer or scope guard reports repeated scope violations.
- The user did not actually authorize a direct PR.

**Pivot boundary — do not silently start a second implementation.** Before you
have made edits, hand off freely. Once edits exist, **stop and report** the exact
branch, commit, and diff, and let the operator decide whether the worker adopts
that branch or restarts. Creating a fresh workspace from `origin/main` while your
edits sit on another branch produces lost work or two diverging PRs.

### Handoff steps

1. `RUNTIME.workspace_for(issue)` → note the returned workspace path as `<wt>`.
2. `RUNTIME.spawn_worker(wt)` → note the returned terminal handle.
3. **Read back before standing down.** Confirm via `RUNTIME.agents` that exactly
   one agent is running **in `<wt>`** — match on the workspace path, not on a
   global list. Zero means the spawn did not take; more than one means a previous
   attempt also succeeded.
4. **Never blindly retry a spawn whose outcome is unknown.** A timeout does not
   mean failure — read back first. Retrying a spawn that actually succeeded
   leaves two workers in one workspace, and a later workspace-wide stop kills both.

To stop a worker, identify it first through step 3. `RUNTIME.stop_terminals(wt)`
stops **every** terminal in that workspace — when more than one is present, stop
by handle via `RUNTIME.terminals(wt)` instead, or report rather than guess.

## Don't

- Forge or hand-edit `docs/declarations/*.json`.
- Use the `scope-guard-degraded` label to bypass snapshot requirements.
- Merge with `gh pr merge --admin` to skip review or failing checks.
- Put `declared_paths` in the issue body — only `denylist` / `allowed-roots`
  fences + snapshot.
- Invent producer flags — unknown arguments are rejected.
- Commit from a shared checkout without first confirming whose branch and whose
  uncommitted work is in it.
