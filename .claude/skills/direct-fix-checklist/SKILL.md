---
name: direct-fix-checklist
description: Use when the user explicitly authorizes the architect to open a direct PR that edits tracked files. Skip for normal queue work — the default is to hand the change to a worker — and skip for gitignored-only local config edits that produce no tracked diff and need no PR scope guard.
---

# direct-fix-checklist

Authorized override when the user explicitly asks the architect to land a
direct PR. Universal policy lives in `AGENTS.md`. This skill is the Claude
architect adapter for authorized tracked edits and the architect role contract.

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

This table keeps vendor commands in one place. It is **not** the broad
runtime-neutral lifecycle seam owned by Issue #1248. The bounded Git/Orca
identity, create, replacement, terminal-start, recovery, and teardown decisions
for the current Orca path are implemented in `scripts/worktree-lifecycle/**`.

**Before any effect, confirm the active runtime matches this table's header.**
Read the authoritative selection (`OPK_RUNTIME_ADAPTER`, default `orca`) rather
than assuming an installed binary is the selected runtime.

| Capability | Active runtime = `orca` |
|---|---|
| `create_and_start_worker(issue)` | `node --experimental-strip-types scripts/worktree-lifecycle/create-continuation.ts --repo-root "<repo-root>" --issue <N> --expected-head <source-sha> --terminal-title "<role> #<N>" --terminal-command "<agent-cli> --model <model>" --apply --json` |
| `agents` | `orca worktree ps --json` → `result.worktrees[].agents[]` (`state`, `interrupted`) |
| `terminals(wt)` | `orca terminal list --worktree "path:<wt>" --json` → `result.terminals[]` (`handle`, `worktreePath`) |
| `close_terminal(handle)` | `orca terminal close --terminal <handle> --json` |
| `stop_terminals(wt)` | `orca terminal stop --worktree "path:<wt>" --json` |

Left-column names are identifiers, not commands. The atomic capability must
create from the exact intended source SHA, bind the worktree to the Issue, and
start the agent while still holding the lifecycle exclusion. It returns the
verified worktree and terminal identities; there is no later transferable spawn
authorization.

**Resolve every placeholder before acting, and fail closed if you cannot:**
`<N>` = the Issue number; `<repo-root>` = `git rev-parse --show-toplevel`;
`<source-sha>` = the fresh full 40-hex SHA of the intended source ref;
`<role>` = what the worker is for; `<agent-cli>` and `<model>` = the worker agent
and model prescribed by the operator's standing routing. Do not guess a missing
agent or model.

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
Do not start a handoff on top of live edits: the atomic actuator creates a new
Issue-bound workspace from the intended source SHA; it does not adopt an
arbitrary branch with uncommitted edits.

### Handoff steps

1. **Freeze source and routing.** Fetch the intended source ref and resolve its
   full 40-hex SHA as `<source-sha>`. Resolve `<agent-cli>`, `<model>`, and
   `<role>` before any effect.
2. **Run the atomic lifecycle actuator once.** Execute
   `create_and_start_worker(issue)`. It owns the initial create, authoritative
   Git/Orca read-back, at most one stable Issue-family replacement, terminal
   creation, terminal read-back, and the shared create/recovery/teardown
   exclusion. Do not issue a manual second create or a separate terminal create.
3. **Accept only a completed worker start.** Proceed only when the report has all
   of:
   - `outcome: worker_spawned`;
   - `terminalSpawnCompleted: true`;
   - `terminalSpawnAuthorized: false`;
   - one `selected.path`;
   - `selectedReadBack.classification.classification: exact_dual`;
   - one `terminal.handle`;
   - `terminal.worktreePath` exactly equal to `selected.path`.

   Any other result preserves disputed state and returns task-level degraded
   control. Do not loop, force-remove, create a third worktree, or spawn another
   terminal.
4. **Observe, do not recreate.** Use `agents` and `terminals(wt)` to observe the
   returned worker. A timeout or missing create/terminal receipt has already
   been settled by read-back inside the actuator. A repeated invocation that
   sees an Issue-family terminal must perform no new create and no new spawn.

To stop a worker, use `close_terminal(handle)` with the exact handle returned by
the actuator. `stop_terminals(wt)` is a broad workspace operation and is not a
substitute for exact-handle ownership.

## Don't

- Forge or hand-edit `docs/declarations/*.json`.
- Use the `scope-guard-degraded` label to bypass snapshot requirements.
- Merge with `gh pr merge --admin` to skip review or failing checks.
- Put `declared_paths` in the issue body — only `denylist` / `allowed-roots`
  fences + snapshot.
- Invent producer flags — unknown arguments are rejected.
- Commit from a checkout without first confirming whose branch and whose
  uncommitted work is in it.

## Architect role contract

When Task/Dispatch assigns architect, or when no role is assigned (read-only
default), decide what must be true, in what order, at which boundaries, and how
success is proved. The implementation planner chooses internal names, file
layout, libraries, and test structure within the published constraints.

### Do

- Author task briefs and governed GitHub Issues with problem, goal, advisory
  tier, constraints, scope fences, scenario classes, acceptance criteria, smoke,
  and verified grounding.
- Use the canonical `create-issue-draft` procedure for new task authoring. Use
  the historical publishing procedure only for an existing tracked artifact when
  the user explicitly requests it.
- Before proposing a non-trivial component or contract, describe critical
  mechanics, integration boundaries, industry patterns, at least three
  materially different options, and the cheapest sufficient choice with explicit
  risks.
- Enumerate the full decision, state, ordering, retry, timeout, identity, and
  concurrency scenario class when the task changes such behavior.
- Use `study-external-source` for adoption research and
  `investigate-root-cause` for recurrence analysis.
- Compare the live Issue, current default branch, current PR head, diff,
  comments, review threads, CI, and repository reality before reaching a
  conclusion.
- Fold valid review findings back into the durable specification or policy
  boundary, not merely into one symptom.
- Preserve planner freedom while making outcomes, invariants, forbidden
  behavior, identity, temporary outcomes, and evidence testable.

### Universal boundaries

Universal edit, runtime-adapter, compatibility, current-head, identity, and
truthfulness boundaries are owned only by [`AGENTS.md`](../../../AGENTS.md).
This role does not restate or override them.

### Planner freedom

The Issue defines observable behavior, boundaries, risks, scenarios, and
acceptance. It should not force an internal function name, import path,
library, or file layout unless that exact surface is already public or is
itself the behavior being changed.

When an implementation can satisfy the same contract more simply or safely, the
planner may choose it. When the Issue accidentally mandates a brittle internal
design, fix the Issue instead of forcing code to match the mistake.

### Cost rule

Choose the cheapest sufficient executor with acceptable risk after accounting
for available tests, review, latency, privacy, and failure cost. Do not choose
a model or tool merely because it is the most capable in the abstract.
