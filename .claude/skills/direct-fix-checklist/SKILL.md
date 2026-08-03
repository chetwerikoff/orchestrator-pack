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

The order that matters. Sections after it cover the steps that need detail;
CI and review are separate concerns and have their own sections.

1. **Confirm authorization** covers this change (§ When to invoke).
2. **Open or identify the issue** and note its number `N`. Implementation PRs
   need one. If you create it, the body **must** carry a fenced `denylist` block
   or step 8 will refuse to run (§ Declaration snapshot).
3. **Work off a base you control.** Confirm the current branch and whether the
   checkout holds anyone's uncommitted work: `git branch --show-current` and
   `git status --porcelain=v1`. If it is shared, dirty, or not yours, create a
   separate worktree from `origin/main` and do everything there.
4. **Branch** from `origin/main` (fetch first — `origin/main` must be current).
5. **Edit** only the paths you intend to declare.
6. **Audit the pending change before committing.** The union of
   `git status --porcelain=v1` (staged, unstaged, untracked) and
   `git diff --name-only origin/main` must equal exactly the paths you intend.
   Anything else present is someone else's work or a stray artifact — find out
   which before you commit. Do **not** use `origin/main..HEAD` here: it compares
   committed trees and cannot see the edits you just made.
7. **Commit the edits.** Do this before step 8 so the snapshot's
   `source_revision` pins the tree being reviewed.
8. **Produce the declaration snapshot** (§ Declaration snapshot).
9. **Commit the snapshot** on its own — the edits are already in step 7.
10. **Pre-push self-check** (§ Pre-push local self-check).
11. **Push**, then **open the PR** with the right body contract (§ PR body issue
    reference).
12. **Read the PR back** — it exists, targets `main`, and
    `git diff --name-only origin/main...HEAD` lists exactly your paths plus the
    snapshot.

## Declaration snapshot

- **Path:** `docs/declarations/<issue_number>.pr-scope.json` — no iteration or
  session id in the filename. Older files in that directory use the retired
  `<issue>.<iteration_id>.json` form; the guard discovers `<issue>.*.json`, but
  only a valid current-schema declaration resolves — a legacy-schema payload is
  rejected fail-closed. Produce a new snapshot; never revive an old one.
- **Owner:** `scripts/pr-scope-declaration.ts` — never hand-edit or forge the JSON.
- **No worker, no session, no runtime needed.** The producer is standalone.

**Prerequisites.** The issue body must contain a fenced `denylist` block or the
producer refuses to run; an `allowed-roots` fence is optional and narrows the
repository ceiling when present. The repository's own `scripts/gh` wrapper must
exist and work — the producer executes `<repo-root>/scripts/gh` directly to read
that body, resolving it by path, so it does **not** need to be on `PATH`. Pass
`--issue-body-file <file>` to skip the lookup entirely.

```bash
node --experimental-strip-types scripts/pr-scope-declaration.ts \
  --issue <N> \
  --declared-paths path/one.ts,path/two.md \
  --declared-prefixes 'plugins/foo/**'

git add docs/declarations/<N>.pr-scope.json
```

Canonical flags: `--issue`, `--declared-paths`, `--declared-prefixes`,
`--issue-body-file`, `--repo-root`, `--output`. `--declared-globs` is a
deprecated alias for `--declared-prefixes`; `--amend` is a compatibility spelling
that only prints a notice. Unknown arguments are rejected, so do not invent
flags. At least one of paths/prefixes is required, and any `--output` must stay
under `docs/declarations/`.

**Scope changed ⇒ re-run the producer** — unless a pivot trigger applies, in
which case stop instead of re-declaring (§ When to pivot). Regenerating is for
changes still inside the authorized change; it is not a way to absorb growth the
operator never authorized. There is no amendment budget.

## PR body issue reference

Three shapes exist, and the diff decides which one you are in —
[`docs/repository_policy.md`](../../../docs/repository_policy.md) is the authority.

- **Implementation** — any path outside the markdown union (`CLAUDE.md`,
  `scripts/**`, `.github/**`, `docs/declarations/**`). Needs a declaration
  snapshot and a closing reference the guard parses: `Closes #N`, `Fixes #N`, or
  `Resolves #N` (case-insensitive, `#` required).
- **Spec-only docs** — whole diff inside the markdown union, signalled with
  `<!-- pr-type: spec-only -->` alone on one line plus a non-closing `Refs #N`.
  No snapshot; the issue stays open. Closing keywords are forbidden.
- **No-ceremony markdown** — whole diff inside the markdown union, detected from
  diff content alone. No snapshot, no signal, and the body must reference **no**
  issue at all; any issue link fails the guard.

The markdown union is `docs/issues_drafts/**/*.md`, `docs/issue_queue_index.md`,
`docs/architecture.md`, `.claude/skills/**/*.md`, and `.cursor/skills/**/*.md`.
A single path outside it drops the whole PR to the implementation shape.

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

The authority is the **required checks reported for the PR's current head** —
read them from the PR rather than from any list here, which goes stale.

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

Merging requires an operator-requested pack review at the **current head** under
the configured `PACK_REVIEWER`, with material findings fixed or rebutted and
required CI green. The requirement is the review, not any one engine.

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

### Vendor command bindings

This table is where the vendor commands live, so they are in one place instead of
scattered through the steps. It is **not** the broad runtime-neutral lifecycle
seam owned by Issue #1248. The bounded Git/Orca read-back and continuity decision
for the current Orca path is implemented in `scripts/worktree-lifecycle/**`.

**Before any effect, confirm the active runtime matches this table's header.**
Read the authoritative selection (`OPK_RUNTIME_ADAPTER`, default `orca`) rather
than assuming an installed binary is the selected runtime — a leftover vendor CLI
will otherwise succeed against the wrong fleet, silently.

| Capability | Active runtime = `orca` |
|---|---|
| `workspace_for(issue)` | `orca worktree create --name <name> --repo "path:<repo-root>" --base-branch origin/main --issue <N> --setup skip --activate` |
| `spawn_worker(wt)` | `orca terminal create --worktree "path:<wt>" --title "<role> #<N>" --command "<agent-cli> --model <model>" --focus` |
| `agents` | `orca worktree ps --json` → `result.worktrees[].agents[]` (`state`, `interrupted`) |
| `terminals(wt)` | `orca terminal list --worktree "path:<wt>" --json` → `result.terminals[]` (`handle`, `worktreePath`) |
| `close_terminal(handle)` | `orca terminal close --terminal <handle> --json` |
| `stop_terminals(wt)` | `orca terminal stop --worktree "path:<wt>" --json` |

Left-column names are identifiers, not commands. Every step below means: look up
the capability in this table, then execute the command it maps to. Postconditions
the mapping must preserve on any runtime: the workspace is created from
`origin/main` and bound to the issue; the worker is **visible to the operator**;
the agent starts **as part of creating its session**, with its model passed
explicitly — never typed into a shell afterwards.

**Resolve every placeholder before acting, and fail closed if you cannot:**
`<N>` = the issue number; `<repo-root>` = `git rev-parse --show-toplevel`;
`<name>` = a workspace name containing `N`; `<role>` = what the worker is for;
`<agent-cli>` and `<model>` = the worker agent and model the operator's standing
routing prescribes — if that is unstated, **ask**, do not guess; `<wt>` = the
workspace path returned by `workspace_for`.

**Mutation fails closed; the scheduler does not.** If the active runtime has no
row for a capability or a placeholder has no authoritative value, do not guess,
force-delete, or use a disputed workspace. Return a bounded task-level degraded
result to the caller/scheduler, naming the active runtime, missing capability or
value, last completed step, branch/PR/head state, and confirmation that no
substitute command ran. Unrelated work must continue.

### When to pivot

Stop the direct path and hand the change over when:

- Scope grows beyond the change the operator authorized.
- Implementation touches plugins/scripts/tests you did not declare.
- The reviewer or scope guard reports repeated scope violations.
- The user did not actually authorize a direct PR.

**Pivot boundary.** Before you have made edits, hand off freely. **Once edits
exist, stop and report** the exact branch, commit, and pending diff, then wait.
Do not start a handoff on top of live edits: the bindings above only create a
workspace from `origin/main`, so there is no way to hand an existing branch to a
worker from here — proceeding would leave your edits stranded and produce a
second, diverging implementation. Adopting an existing branch is an operator
decision carried out by hand, not a step in this procedure.

### Handoff steps

1. **Census first.** Execute `terminals(wt)` for the target workspace, or note
   that the workspace does not exist yet. Keep the set of existing handles — the
   terminal read-back depends on knowing the "before" state.
2. Execute `workspace_for(issue)` **once**; note the returned workspace path as
   `<wt>`. A timeout or lost receipt is an unknown outcome, not permission to
   issue a blind second create.
3. **Mandatory post-create dual read-back before spawn.** Resolve the created
   worktree's full `HEAD` and branch (or confirmed detached mode) from Git, then
   run:

   ```bash
   node --experimental-strip-types scripts/worktree-lifecycle/cli.ts \
     --context post-create \
     --repo-root "<repo-root>" \
     --worktree "<wt>" \
     --issue <N> \
     --expected-head <full-40-hex-head> \
     --expected-branch <branch> \
     --json
   ```

   Replace `--expected-branch` with `--detached` only when Git itself confirms
   detached HEAD. Proceed only for `outcome: ready_to_spawn`,
   `classification.classification: exact_dual`, and
   `decision.terminalSpawnAuthorized: true`.
4. **Bounded continuation, not a global stop.** For any other post-create result,
   preserve the disputed target. Do not spawn in it and do not destructively
   recover it by Issue number. Perform at most one isolated replacement create
   with a fresh unique `<name>` and path, still rooted at the exact intended
   source SHA and bound to the same Issue. Run step 3 against the replacement.
   If the replacement is also not exact dual, return task-level degraded control
   immediately; do not loop and do not stop unrelated scheduler work.
5. Execute `spawn_worker(wt)` only for the exact-dual original or replacement;
   note the returned terminal handle.
6. **Read back and bind.** Execute `terminals(wt)` again: there must be **exactly
   one handle that was not in the step-1 set**, and that handle is your worker.
   Zero new handles means the spawn did not take. More than one means something
   else is also creating terminals — preserve the state and return task-level
   degraded control rather than guessing. Use `agents` to confirm the bound
   handle is running.
7. **Never blindly retry a spawn whose outcome is unknown.** A timeout does not
   mean failure — read back first. Counting agents alone cannot tell your worker
   from one that was already there, which is why step 1 is not optional.

To stop a worker, use `close_terminal(handle)` with the handle bound in step 6.
