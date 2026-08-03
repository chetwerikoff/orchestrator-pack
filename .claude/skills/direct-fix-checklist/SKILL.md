---
name: direct-fix-checklist
description: Use when the user explicitly authorizes the architect to open a direct PR that edits tracked files. Skip for normal queue work — the default is to hand the change to a worker — and skip for gitignored-only local config edits that produce no tracked diff and need no PR scope guard.
---

# direct-fix-checklist

Authorized override when the user explicitly asks the architect to land a
direct PR. Architect role context: `CLAUDE.md` (default is handing the change
to a worker; this skill is the only supported bypass).

## Runtime profile (the ONLY runtime-specific surface — swap this, not the steps)

The agent runtime is pluggable. Every step below is written against **capability
names**, never against a vendor CLI. To move to a different runtime, replace the
right-hand column here; **do not edit the procedure steps**.

| Capability | Active runtime = `orca` |
|---|---|
| `RUNTIME.workspace_for(issue)` | `orca worktree create --name <name> --repo "path:<repo-root>" --base-branch origin/main --issue <N> --setup skip --activate` |
| `RUNTIME.spawn_worker(wt)` | `orca terminal create --worktree "path:<wt>" --title "<role> #<N>" --command "<agent-cli> --model <model>" --focus` |
| `RUNTIME.worker_status` | `orca worktree ps --json` → `result.worktrees[].agents[]` (`state`, `interrupted`) |
| `RUNTIME.stop_terminals(wt)` | `orca terminal stop --worktree "path:<wt>" --json` |

Base branch is `origin/main`, never local `main`. `--activate` is required or the
operator cannot see the worker. Spawn the agent with `--command` at terminal
creation — never by typing it into a shell via `send`.

**Fail closed.** If the active runtime has no row for a capability a step needs,
**stop and report blocked**. Do not improvise a substitute command, and do not
fall back to the direct path because the handoff was inconvenient.

**Why a profile table and not the pack adapter:** the repo's runtime-neutral
contract (`scripts/runtime/contracts.ts`, composition root `selectRuntimeAdapter`
in `scripts/runtime/registry.ts`, selected by `OPK_RUNTIME_ADAPTER`, default
`orca`) is a **library**, not an operator CLI — its only production caller is
`scripts/launch-watch/watch.ts`. It also covers workers/terminals only, with **no
worktree lifecycle**, and its `stop_worker` deliberately refuses a destructive
close on the active runtime (`docs/orca-runtime-boundary.md`). So `spawn_worker`
and `stop_worker` there are **contract operation names, not shell commands** —
never instruct anyone to "run" them. Extending the contract to cover workspace
lifecycle is the durable fix; until then this table is the single swap point, and
this skill must not grow a second, rival runtime abstraction beside the pack's.

## When to invoke

- User clearly authorizes **this PR** to be an architect-direct edit (e.g.
  "fix it yourself", "open a PR for this doc change now").
- The change must touch tracked files that CI scope-guard enforces.

## When to skip

- Normal queue work → hand it to a worker (`RUNTIME.workspace_for` +
  `RUNTIME.spawn_worker`) and let the planner declare and implement.
- Gitignored-only edits that leave the tracked diff empty (e.g. local runtime
  config under `.gitignore`) — no PR, no scope guard.
- User has not named a specific authorized direct PR.

## Declaration snapshot

- **Path:** `docs/declarations/<issue_number>.pr-scope.json` — **no iteration or
  session id in the filename.** Older files in that directory use the retired
  `<issue>.<iteration_id>.json` form; the guard discovers `<issue>.*.json`, so
  both shapes resolve, but new snapshots use the `pr-scope` name.
- **Owner:** `scripts/pr-scope-declaration.ts` — never hand-edit or forge the JSON.
- **No worker, no session, no runtime needed.** The producer is standalone.

### Produce the snapshot

**Prerequisite:** the pack `scripts/gh` wrapper must be on PATH — the producer
reads the issue body through it to parse the `allowed_roots` / `denylist` fences.
Pass `--issue-body-file <file>` instead when `gh` is unavailable.

```bash
node --experimental-strip-types scripts/pr-scope-declaration.ts \
  --issue <N> \
  --declared-paths path/one.ts,path/two.md \
  --declared-prefixes 'plugins/foo/**'
```

Accepted flags — the parser rejects anything else with `unknown argument`:
`--issue`, `--declared-paths`, `--declared-prefixes`, `--issue-body-file`,
`--repo-root`, `--output`, `--amend`, `--help`. At least one of
`--declared-paths` / `--declared-prefixes` is required. Any `--output` must stay
under `docs/declarations/`.

Commit **only** the snapshot plus in-scope edits:

```bash
git add docs/declarations/<N>.pr-scope.json
```

**Scope changed ⇒ re-run the producer.** There is no amendment budget and no
once-per-iteration rule. `--amend` survives only as a compatibility spelling that
prints a notice; it does not amend anything.

## PR body issue reference

**Implementation** direct PRs **must** include a closing reference the scope
guard parses:

- `Closes #N`, `Fixes #N`, or `Resolves #N` (case-insensitive, `#` required).

**Spec-only docs** direct PRs use the lighter path documented in
[`docs/repository_policy.md`](../../../docs/repository_policy.md#spec-only-docs-prs):
`<!-- pr-type: spec-only -->` alone on one line plus a non-closing `Refs #N` (no
snapshot, issue stays open). That path covers `docs/issues_drafts/**`,
`docs/issue_queue_index.md`, and `.claude/skills/**/SKILL.md` — including edits to
this file. Do not use closing keywords on spec-only PRs.

## Pre-push local self-check

From repository root:

```powershell
.\scripts\verify.ps1
.\scripts\test-all.ps1
```

Fix failures before push — do not use CI as the first scope check.

## CI checks the PR must pass

From `.github/workflows/scope-guard.yml` (job `name` fields):

| Job name | What it runs |
|----------|--------------|
| **Classify PR changes** | markdown-only classification; gates the test jobs below |
| **Verify orchestrator-pack structure** | `verify.ps1`, `check-reusable.ps1`, `check-ci-cheap-wins.ps1`, `check-verify-runtime.ps1`, `npm run tiering:calibration`, `check-ci-pipeline-split.ps1` |
| **PR scope guard** | `scripts/pr-scope-check.ps1` (launcher for `pr-scope-check.ts`) — see note below |
| **Type-check pack sources** | `tsc --project tsconfig.base.json --noEmit`, `check-review-start-claim-guard.ps1` |
| **Vitest light lane N/M** | `run-vitest-light-lane.ps1` (sharded) |
| **Plan Vitest heavy topology** | derives the heavy shard topology |
| **Vitest heavy shard N/M** | `run-vitest-heavy-shard.ps1` (sharded) |
| **Pester regression** | `test-all.ps1 -SkipNpm` |
| **Run pack contract tests** | fail-closed aggregate `ci-test-aggregate.ps1` over the jobs above |
| **Self-architect lint** | `lint-self-architect.ps1 -Strict` (PRs only) |

All must be green before merge.

**The scope guard runs from the trusted _base_ checkout, not your branch.** A fix
to the guard itself does not take effect on the PR that introduces it.

## PR review (operator-initiated only)

**Never self-initiate a review** — architectural or PR, on any engine. The user
decides when a review runs. When the operator orders a review of this PR, run the
pack-owned runner **from the trusted pack checkout**, never from the reviewed
worktree:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n>
```

Optional head pin: `--head-sha <40-hex>`. Status: `... list`. `--session-id` is for
worker PRs; a direct architect PR needs only `--pr-number`.

The reviewer engine is selected by the `PACK_REVIEWER` env var (`codex | claude |
gpt`), resolved in `scripts/lib/resolve-pack-reviewer.ts` and bound into the
reviewer child by the runner. To change it, use the `switch-pack-reviewer` skill —
do not invoke a reviewer plugin directly; the runner owns claim, cap, head binding,
and is the sole GitHub publisher.

**Verdict contract** — the runner requires a terminal JSON payload on stdout:

| Reviewer stdout | Meaning |
|-----------------|---------|
| `{"verdict":"clean","findingCount":0,"findings":[]}` | Clean — safe to merge after CI |
| `{"verdict":"findings",...}` with matching `findingCount` | Actionable findings — fix or rebut before merge |
| Empty stdout | **Not** clean — the run failed |
| Prose narration ("No concrete bugs…") | **Not** clean — no valid terminal verdict |

`findingCount` must equal `findings.length` or the runner hard-errors. Treat
P0/P1 before merge; P2 may be tracked in the issue if accepted.

**Not for issue drafts:** architect spec review uses `codex review` or
`scripts/review-architect-artifact.ts` — see the `create-issue-draft` skill.

## Pivot back to a worker

Stop the direct path and hand the change over when:

- Scope grows beyond what you declared, so the declared scope no longer matches
  the diff.
- Implementation touches plugins/scripts/tests you did not declare.
- The reviewer or scope guard reports repeated scope violations.
- User did not actually authorize a direct PR.

Then, using the runtime profile above:

1. `RUNTIME.workspace_for(issue)` — isolated workspace bound to issue `N`.
2. `RUNTIME.spawn_worker(wt)` — agent launched with its model passed explicitly.
3. `RUNTIME.worker_status` — confirm the worker is actually live before standing down.

Stop a stuck worker with `RUNTIME.stop_terminals(wt)`, and only after confirming
its identity from `RUNTIME.worker_status` — never from a guessed id.

## Don't

- Forge or hand-edit `docs/declarations/*.json`.
- Use the `scope-guard-degraded` label to bypass snapshot requirements.
- Merge with `gh pr merge --admin` to skip review or failing checks.
- Put `declared_paths` in the issue body — only `denylist` / `allowed-roots`
  fences + snapshot.
- Invent producer flags — `scripts/pr-scope-declaration.ts` rejects unknown
  arguments; the canonical spellings are `--declared-paths` / `--declared-prefixes`.
- Instruct anyone to "run" a runtime-port operation. `spawn_worker` / `liveness` /
  `stop_worker` in `scripts/runtime/contracts.ts` are contract names with no CLI.
