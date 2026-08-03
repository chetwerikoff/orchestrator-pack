---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely pull main in the live checkout, apply documented local
  operator adoption, then tear down the merged PR's Orca worktree — stop its terminals,
  reap every process the agents left running inside it (including setsid-detached MCP
  servers that survive PTY teardown), remove the worktree, and delete the local branch
  (Step 9). Use when the user asks to merge a finished task — «мерж», «мерж 385»,
  «мерж и пул», «смерж», «merge», «merge and pull» — or clearly wants a ready PR merged
  after review/CI. On a direct merge order, normalize what can be normalized instead of
  stopping — draft → ready for review, BEHIND → update-branch — while required CI that is
  not green (red, pending, or never reported) still stops, and `--admin` cannot force it
  because `main` sets `enforce_admins` (Step 3a). If CI is red or the branch is behind
  base, delegate the fix to the PR worker (Step 3b) and merge only after CI is green.
  Operates on the operator's live working tree; never discards uncommitted local work and
  never reaps a worktree that still holds unmerged or uncommitted work (Step 9b).
  Skip when the user only discusses merge policy without a concrete PR.
---

# Merge with local adoption

Run end-to-end from the **operator terminal** on the **live checkout**
(`/home/che/projects/orchestrator-pack`). Never delegate merge/pull to nested agents.
Orca lifecycle commands and worktree probes run from the operator terminal only — never
from inside the worktree you are about to tear down.

`N` in the trigger («мерж 385») is an issue **or** PR number — resolve in Step 2.

## Runtime profile (the ONLY runtime-specific surface — swap this, not the steps)

The agent runtime is pluggable. Steps 3b and 9 are written against **capability names**, never
against a vendor CLI. To move to a different runtime, replace the right-hand column here and the
inventory command below; **do not edit the procedure steps**.

| Capability | Active runtime = `orca` |
|---|---|
| `RUNTIME.worktrees` | `orca worktree list --json` → `result.worktrees[]` |
| `RUNTIME.worktree_current` | `orca worktree current --json` → `result.worktree` |
| `RUNTIME.agents` | `orca worktree ps --json` → `result.worktrees[].agents[]` |
| `RUNTIME.terminals(wt)` | `orca terminal list --worktree "path:<wt>" --json` → `result.terminals[]` |
| `RUNTIME.terminals_all` | `orca terminal list --json` → `result.terminals[]` (global; needed for the tab guard) |
| `RUNTIME.close_pane(h)` | `orca terminal close --terminal <h> --json` (no `--tab`; single pane only) |
| `RUNTIME.send(h,text)` | `orca terminal send --terminal <h> --text "…" --enter` |
| `RUNTIME.stop_terminals(wt)` | `orca terminal stop --worktree "path:<wt>" --json` |
| `RUNTIME.close_tab(h)` | `orca terminal close --terminal <h> --tab --json` |
| `RUNTIME.remove_worktree(wt)` | `orca worktree rm --worktree "path:<wt>" --json` |

Field mapping for the active runtime: worktree rows expose `path`, `head`, `branch` (**full ref**,
empty when detached), `isMainWorktree`, `isArchived`, `displayName`, `repoId`; agent rows expose
`state` and `interrupted`; terminal rows expose `handle`, `worktreePath`, `tabId`.

**Neutral inventory for the reaper** — the reaper never calls a runtime CLI. Produce its input by
normalising `RUNTIME.worktrees` to `[{path, isMain}]`:

```bash
orca worktree list --json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const w=JSON.parse(s).result.worktrees.map(x=>({path:x.path,isMain:!!x.isMainWorktree}));
  process.stdout.write(JSON.stringify(w));})' > "$RUN_DIR/rt-worktrees.json"
```

**Why a profile table and not the pack adapter:** the repo's runtime-neutral contract
(`scripts/runtime/contracts.ts`, composition root `selectRuntimeAdapter` in
`scripts/runtime/registry.ts`) covers workers/terminals only and has **no worktree lifecycle
operations** — and it deliberately refuses destructive close. Extending it to cover teardown is the
durable fix (follow-up 3); until then this table is the single swap point, and this skill must not
grow a second, rival runtime abstraction beside the pack's.

## Active-runtime facts (steps rely on these; stated once)

The agent runtime is **Orca**. **AO is retired** — the `ao` binary may still sit on PATH,
but the daemon does not run and every `ao` call fails. Do not port AO procedures: there is
no session layer, no `ao session ls/kill/restore/cleanup`, no ProjectConfig, no
`AO_ORCHESTRATOR_SESSION_ID`, and no separate orchestrator runtime worktree. `docs/orchestrator-recovery-runbook.md`,
`scripts/wait-orchestrator-launch.ps1`, `scripts/orchestrator-worktree-preflight.ps1`,
`docs/pr-session-binding-cache.mjs`, and the `change-orchestrator-runtime` skill are
AO-era artifacts and are **not** part of this flow.

- **The orchestrator runs in the main checkout.** `orca worktree current --json` from
  `/home/che/projects/orchestrator-pack` returns that same path with
  `isMainWorktree: true`. The AO hazard of a separate runtime clone drifting from the
  operator's tree has no Orca analogue.
- **Worktree selectors:** `path:<abs>`, `branch:<branch>`, `issue:<number>`,
  `name:<displayName>`, `id:<repoId>::<path>`, `active`, `current`.
- **`linkedPR` and `linkedIssue` are `null` on every row** in practice — nothing sets them
  today. The `issue:<n>` selector therefore cannot resolve a merged PR's worktree.
  **Branch is the only trustworthy join key** (Step 9a).
- `orca worktree list --json` → `result.worktrees[]`: `id`, `path`, `head`, `branch`
  (**full ref**, e.g. `refs/heads/x`; **empty string** when the worktree is detached),
  `isMainWorktree`, `isArchived`, `displayName`. `orca worktree ps --json` adds
  `liveTerminalCount`, `status`, and `agents[]` with `state`/`interrupted` — and it is
  **global across repos**, so filter by repo.
- `orca terminal list --json` → `result.terminals[]`: `handle`, `worktreeId`,
  `worktreePath`, `tabId`, `connected`, `orphaned`.
- **`orca worktree rm` does not stop terminals and does not reap processes.** Verified
  2026-08-03: 37 live processes across 8 already-removed worktrees still hold
  `… (deleted)` CWDs — leaked `codex app-server` trees, node brokers, codex vendor
  binaries, and `synto serve` MCP servers. One leaked process had even **recreated its
  worktree directory after removal**. This is why Step 9 stops and reaps *before* `rm`.
- `orca terminal send --terminal <h> --text "…" --enter` — the Enter can silently fail to
  land; always verify delivery by reading the terminal back, never assume.
- The repo has **no `orca.yaml`**, so `orca worktree rm --run-hooks` is a no-op. Do not
  pass it.
- `jq` is **not** installed — parse JSON with `node -e`. `ps aux` is blind to `pwsh` —
  use `/proc` (the reaper does).
- Pack review is run by the **pack-owned runner**. The session-less form
  `node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number <n>
  --head-sha <40-hex>` is live; the `--session-id` form is AO-dead. GitHub PR review is
  the authoritative verdict.

## Rule zero — never destroy local work

**FORBIDDEN:** `git reset --hard`; `git clean`; `git checkout -- .` / `git restore`
(anything discarding work); `git switch -f` / `checkout -f`; `git stash drop/clear`;
`git pull --rebase` on a dirty tree; autostash without a same-run pop + report; deleting
or overwriting files the user had modified or untracked; `git branch -D` (use `-d`, which is
itself an ancestry check — the **only** exception is the squash/rebase path in 9b G5, after tree
containment has been proven, and it must be named in the report); `orca worktree rm --force`;
`orca worktree rm --run-hooks`
(executes repo-defined code from the merged branch as the operator — see 9e); `rm -rf` on
any worktree. Never run two teardowns concurrently — take the 9b lock.

**FORBIDDEN in process teardown:** killing by command line or process name. `pkill -f
'synto serve'`, `pkill -f codex`, `killall node` and every relative of theirs are banned
outright — verified 2026-08-03, three independent per-agent `synto serve` instances plus
the operator's own were running at once, and a name match would have killed all of them.
Ownership is established by CWD + ancestry via `reap-worktree.mjs`, never by a name. Never
signal PID 1, a negative PID, or process-group 0.

**REQUIRED:** keep the Step 1 snapshot for the report; re-run `git status --short` after
every git step (no tracked file may vanish unexplained); if a git command refuses because
of local changes — **stop and report**, never "fix" by discarding; prefer `git fetch` +
explicit merge over exotic pull flags; every destructive Step 9 verb runs only after its
gate passed, and a failed gate aborts teardown while leaving the merge itself intact.

## Step 1 — Pre-flight snapshot (mandatory)

Save the output of:

```bash
git rev-parse --show-toplevel; git branch --show-current
git status --short; git diff --stat; git diff --cached --stat; git stash list
```

If `git status --short` is non-empty: **dirty tree — safe pull only (Step 6c)**.

Assert you are on the live checkout — the whole of Step 6 targets the wrong tree otherwise:

```bash
RUNTIME.worktree_current      # .path must be /home/che/projects/orchestrator-pack
```

Not the main checkout → **stop and report** before any merge.

## Step 2 — Resolve the PR

With user number `N`, in order: (1) `gh pr view N --repo chetwerikoff/orchestrator-pack
--json number,title,body,state,mergeable,headRefName,url` — if valid, `P=N`;
(2) open PR for issue `N`: `gh pr list --state open --search "N" --json
number,title,body,headRefName`, prefer body containing `Closes/Fixes/Resolves #N`;
(3) no number: PR for current branch (`gh pr view`), or the URL/branch the user named.
Zero or multiple matches → **ask once**, don't guess.

Record PR `P`, title, linked issue `I`, and **`HEAD_REF` = `headRefName`** — Step 9a's
only join key. Bind the worktree now, while the branch is easy to read:

```bash
HEAD_REF="$(gh pr view P --repo chetwerikoff/orchestrator-pack --json headRefName -q .headRefName)"
```

## Step 3 — Confirm merge readiness

Unless the user explicitly waives checks (see also **Step 3a** — a direct merge order
normalizes blocking statuses instead of stopping on them). **A waiver never skips the
status read under a direct order:** Step 3a needs it to see the draft flag, `BEHIND`, and
required CI, and without it the run reaches Step 5 with no normalization decision and no
way to honour the required-CI stop. Waiving optional checks waives waiting on them, not
reading where the PR stands.

```bash
gh pr checks P --repo chetwerikoff/orchestrator-pack
gh pr view P --json mergeable,reviewDecision,state,mergeStateStatus,statusCheckRollup,isDraft
```

Stop without merging if state ≠ `OPEN`, not `MERGEABLE`, required checks failing, or
review blocking — **except** for the statuses Step 3a normalizes under a direct merge
order.

## Step 3a — Direct merge order: normalize blocking statuses

**Applies only when the user gave a direct, concrete merge command** («мерж 385», «смержи
этот PR», "merge #907"). It does **not** apply to autonomous/proactive merges, to a merge
you proposed yourself, or to policy discussion without a concrete PR.

Under a direct order the default posture flips for the statuses below: they are **not** a
stop, they are something to transition into a merge-appropriate state before Step 5. Do
not ask the user to unblock what you can normalize yourself.

Normalize, in this order, then re-run the Step 3 status read:

1. **Draft PR** (`isDraft: true`) → `gh pr ready P --repo chetwerikoff/orchestrator-pack`,
   then continue the normal flow (merge **with local adoption**, Steps 4–10 unchanged).
2. **Branch `BEHIND`** → `gh pr update-branch P` from the operator session; wait for the
   new head's checks before merging.

**Required CI that is not green stays a stop** — failing, pending, queued, or never
reported. A direct order does not authorize merging past it. Go to Step 3b (delegate the
fix to the PR worker) when it is red; when a required check simply never ran, make it
report and resume at Step 3 (for `orchestrator-pack/pack-review`:
`node --experimental-strip-types scripts/pack-review-runner.ts start --pr-number P
--head-sha <head>`). `--admin` is not an escape from this: on `main` the branch protection
sets `enforce_admins`, so GitHub refuses an admin merge over a required check that is
`expected` or `failing` (verified live 2026-07-20). Say so in one line rather than
attempting a merge that cannot succeed.

**A blocking review verdict is also a stop by default.** `orchestrator-pack/pack-review`
is a required status, so an unresolved blocking finding holds the merge; `--admin` cannot
override it (`enforce_admins`). Default: fix the finding or re-run review on the current
head.

**Operator waiver (explicit only):** when the operator **explicitly** authorizes merging
with the open pack-review finding and every **other** required context is already green,
follow [`docs/pack-review-waiver-merge-runbook.md`](../../../docs/pack-review-waiver-merge-runbook.md)
— post a newer `success` commit status on the exact PR head SHA (Statuses API), then
merge normally and continue this skill from Step 4. Record the waiver verbatim in Step 10.
Waiver does not clear findings in the pack store or GitHub comments.

Also still a stop, direct order or not: PR state ≠ `OPEN` (already merged/closed), and
merge conflicts that need a real resolution (`mergeable: CONFLICTING`) — those go to the
worker via Step 3b.

Every status you flipped or bypassed here goes into the Step 10 report verbatim, so the
operator sees what the direct order overrode.

## Step 3b — Worker handoff when CI red / branch behind

If checks fail or `mergeStateStatus` is `BEHIND`: **stop before Step 4**. Do not patch
worker-scope implementation from the architect session — delegate to the PR worker.

**Under a direct merge order, `BEHIND` does not reach this step** — Step 3a already
updated the branch, and you arrive here only for red required CI or a real conflict.
Everywhere else `BEHIND` still stops and delegates.

1. **Resolve the worker terminal** — the PR's worktree by branch (Step 9a's R2 ladder),
   then its live terminals:

   ```bash
   RUNTIME.terminals("$WP")      # → handles
   ```

   No worktree or no live terminal → report the blocker; offer to spawn a worker only if
   the user asks.
2. **Send the fix task** (collect evidence first: `gh pr checks P`, `gh run view <id>
   --log-failed`):

   ```bash
   RUNTIME.send("$H", "<task>")
   # then read that terminal back — verify the text actually landed
   ```

   Include PR `P`, branch, issue `I`, failing checks + top log lines, the sync-with-main
   requirement if behind, and an explicit **do not merge** (architect resumes at Step 3).
   The Enter can fail to land — the read-back is mandatory, not optional.
3. **Wait, then resume at Step 3** when checks are green and the branch is not behind (run
   `gh pr update-branch P` from the operator session if needed). Merge and teardown always
   run **after** CI is green — never in parallel with an in-flight worker fix.

## Step 4 — Collect adoption instructions; classify rules-channel touching

Before merging, read: PR body (`## Operator adoption`), `gh pr diff P --name-only` (+
content for `.example`/runbooks/env docs), linked issue `I` body, the draft under
`docs/issues_drafts/` (via `docs/issue_queue_index.md`) if the body is thin, and
`migration_notes.md` hunks in the diff.

**Adoption-likely surfaces** (any change ⇒ check for local operator work): `.example` /
env docs; machine-local CLI config (`~/.cursor/cli-config.json`,
`.claude/skills/discuss-with-gpt/local.config.json`); runbook/go-live docs; anything
requiring a long-running process restart. Do not report «адаптации нет» without scanning
these.

**Rules-channel touching** replaces the AO-era "runtime-sensitive" judgment call. Without
AO ProjectConfig there is nothing to re-push into a daemon, so the classification collapses
to one mechanically decidable question: *did this merge change a file that an
already-running agent loaded at startup and will not re-read?*

```bash
gh pr diff P --repo chetwerikoff/orchestrator-pack --name-only \
  | grep -E '^(AGENTS\.md|CLAUDE\.md|\.cursor/rules/|prompts/|\.claude/skills/)' && RULES_TOUCHED=yes
```

It is a path glob, not a judgment — there is nothing to be unsure about. Its only
consequence is the Step 8 sibling advisory.

Tell the user in one short block (their language) what local work follows the merge, or:
«Локальных настроек нет — мержу без post-merge шагов».

## Step 5 — Merge

```bash
gh pr merge P --repo chetwerikoff/orchestrator-pack --merge --delete-branch
gh pr view P --json state,mergedAt,mergeCommit
```

`--squash`/`--rebase` only if the user asked. Record `MERGE_SHA` from `mergeCommit.oid`.
On failure: stop, report stderr, no force-retry. No local `git merge` of the PR branch.

**`--delete-branch` deletes the remote ref only** — the local branch survives at a stale
SHA and is removed in Step 9f.

**Do not reach for `--admin` when this command fails.** `main` protection sets
`enforce_admins`, so the flag cannot force a required check that is `expected` or
`failing` — the attempt just fails again, and reaching for it after a failure is the
force-retry this step forbids. Take the failure to Step 3 / Step 3b instead.

## Step 6 — Safe pull in the live checkout

Run when the user asked for pull or adoption needs merged `main`. Skip only when the user
explicitly asked not to update the local tree **and** no adoption needs it.

- **6a:** `git fetch origin`; record `ORIGIN_MAIN="$(git rev-parse origin/main)"`.
- **6b (clean tree):** `git checkout main && git pull --no-rebase origin main`.
- **6c (dirty tree):** try `git checkout main 2>&1 || true`. If refused: stay on branch —
  `git branch -f main origin/main` **only if NOT on main and only after**
  `git merge-base --is-ancestor main origin/main` exits 0 (local `main` has no unique
  commits; if it fails — stop and report the divergent commits, never force the ref), or
  `git merge --no-edit origin/main`. If you must be on `main`:

  ```bash
  git stash push -u -m "merge-with-local-adoption preserve $(date -u +%FT%TZ)"
  git checkout main && git pull --no-rebase origin main && git stash pop
  ```

  Conflicts on pop → **leave the stash entry**, report conflicted paths. If pull refuses
  (local changes would be overwritten) → **stop**, report paths; offer the stash path only
  after telling the user what will be stashed.
- **6c':** if checkout to `main` **succeeds** with the dirty changes carried over: still
  run `git pull --no-rebase origin main` — do not leave local `main` stale.
- **6d:** `git status --short; git log -1 --oneline` — every pre-flight dirty path must
  still be accounted for.
- **6e — live-checkout containment** (replaces the AO orchestrator worktree probe, which
  has no Orca analogue):

  ```bash
  git merge-base --is-ancestor "$MERGE_SHA" HEAD    # must exit 0
  ```

  Fails → the pull did not land; stop and report before Step 7.

## Step 7 — Apply local operator adoption

Execute only what Step 4 documented. Surgical edits only (named files/keys). Do not commit
live secrets or machine-local config unless the user asked in the same message. Don't
invent secrets/ports — copy from PR/docs. Ambiguous adoption → minimal safe change + open
questions in the report. Then `git status --short` — pre-existing dirty files must remain.

## Step 8 — Sibling worktree staleness (advisory; only when `RULES_TOUCHED=yes`)

Long-lived manager worktrees (`fm-*`, `mgr-*`) do **not** auto-sync, and their agents read
`AGENTS.md` / `.cursor/rules/*.mdc` from **their own tree** at startup — a running agent
has already loaded them and will not re-read. This is the only surviving piece of the AO
Step 8.

Report, for each non-main, non-archived worktree of this repo:

```bash
git -C "<wp>" rev-list --count HEAD..origin/main     # how far behind
orca worktree ps --json                              # agents[].state for that row
```

```
fm-pr-triple  | chetwerikoff/fm-pr-triple | behind: N | agent: cursor/working | rules stale: yes
mgr-1196      | (detached)                | behind: N | agent: cursor/done    | rules stale: yes
```

**This step never blocks Step 9.** It is an advisory only: emit the table, then **go straight to
Step 9** and tear the merged PR's worktree down. Ask about recycling siblings **after** Step 9
has finished, as the last thing before the report. Getting this backwards is self-defeating —
`.claude/skills/**` is itself inside the rules-channel glob, so a merge that touches this very
skill would stop here and never reach the teardown that is the whole point of the run.

When you do ask: **never auto-recycle.** Killing a live manager mid-run is a strictly worse
failure than a stale rules file, a manager may be mid-turn on an unrelated PR, and the standing
operator decree is that workers are not interrupted — you add a terminal, you do not kill one.

If the operator says yes, the sibling recycle uses the **same Step 9b gate and Step 9c
ordering**, except `rm` is replaced by `git -C <wp> merge --ff-only origin/main` plus a
fresh `orca terminal create`. If `--ff-only` fails, **stop** — never force a sibling's ref.

## Step 9 — Orca worktree teardown (mandatory after a successful merge)

From the operator terminal, after Step 7 (and Step 8 when it ran). This step exists
because `orca worktree rm` alone leaks: it stops nothing and reaps nothing.

### 9a — Resolve the worktree (branch is the only join key)

```bash
RUNTIME.worktrees > "$RUN_DIR/wt.json"          # active runtime: orca worktree list --json
node -e '
const r=JSON.parse(require("fs").readFileSync("$RUN_DIR/wt.json","utf8")).result.worktrees, ref=process.argv[1];
const repo=r.find(w=>w.path==="/home/che/projects/orchestrator-pack").repoId;
const m=r.filter(w=>w.repoId===repo && !w.isMainWorktree && !w.isArchived &&
  (w.branch||"").replace(/^refs\/heads\//,"")===ref);
console.log(JSON.stringify(m.map(w=>({path:w.path,name:w.displayName,branch:w.branch})),null,2));
' "$HEAD_REF"
```

(The parsing above reads the active runtime's field names — if you swap runtimes, re-map
them from the Runtime profile table; the *ladder* below is runtime-independent.)

Ladder — stop at the first rung that resolves:

- **R1 — `linkedPR === P`.** Always null today; keep the rung for when worktree creation
  starts setting it (see "Follow-ups" below).
- **R2 — exact branch equality**, scoped to this repo, `isMainWorktree: false`,
  `isArchived: false`. **Exactly one match is the only auto-teardown authorization in
  this skill.** Git forbids one branch in two worktrees, so >1 is structurally impossible
  — if it happens, **stop** (registry corruption). Zero matches → R3.
- **R3 — ask once, don't guess.** List every non-main worktree with `displayName`,
  `branch` (or `(detached)`), `head`, and `agents[].state`, and ask the operator to name
  one or say "none". **Never** act on a name or issue-number substring heuristic.

**Why this does not reap a long-lived manager.** A manager worktree matches R2 only if its
branch *is literally the merged PR's head* — merely having touched, reviewed, or driven
the PR is invisible to a branch join, and a detached manager (`mgr-1196`, empty `branch`)
can never match at all. The residual case is real but narrow: a PR opened **from** a
manager's own branch would match, and there the worktree genuinely is that PR's worktree.
The **9b G6 agent-state gate** is what protects it — an active manager never passes it.
Never weaken R2 into a name heuristic on the theory that the gate will catch mistakes:
the two guards are independent on purpose.

**Fail closed:** `orca worktree list` erroring, returning non-`ok`, or an empty `HEAD_REF`
⇒ **no teardown at all**. Report it; the merge still stands. Absence of evidence is never
authorization to delete.

### 9b — Safety gate (every check must pass; one failure aborts teardown)

**Concurrency and scratch files.** Two teardowns must never overlap. A shell-local
`exec 9>…; flock -n 9` is **useless here** — each command block you run is a separate shell, so
the lock dies the moment that block ends and the next block runs unprotected.

Use a lock that outlives the process, and private scratch files (a fixed `$RUN_DIR/wt.json` both races
a concurrent run and follows a planted symlink on redirect):

```bash
RUN_DIR="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/opk-teardown.XXXXXX")"   # mode 0700
LOCK="${XDG_RUNTIME_DIR:-/tmp}/opk-teardown.lockdir"
mkdir "$LOCK" 2>/dev/null || { echo "another teardown holds $LOCK — stop"; exit 1; }
# mkdir is atomic and its result persists across separate shells, unlike a shell-local flock FD.
```

Every subsequent step writes only under `$RUN_DIR` (`$RUN_DIR/wt.json`, `$RUN_DIR/rt-worktrees.json`).
Release with `rmdir "$LOCK"` **only** at the very end of Step 9, including on the abort paths — and
report if you ever find a stale `$LOCK` you did not create rather than removing it blindly.

```bash
WP=<resolved abs path>
git -C "$WP" symbolic-ref -q --short HEAD                 # G1: must equal $HEAD_REF (no drift since 9a)
git -C "$WP" status --porcelain --untracked-files=all     # G2a: must be EMPTY
git -C "$WP" status --porcelain --ignored=matching \
  | grep '^!! ' | grep -vE '^!! (node_modules|\.venv|venv|dist|build|\.turbo|\.next|coverage|__pycache__)/' \
                                                          # G2b: must be EMPTY (see below)
git -C "$WP" log --oneline origin/main..HEAD              # G3: must be EMPTY (no unmerged commits)
git fetch origin
git merge-base --is-ancestor "refs/heads/$HEAD_REF" origin/main   # G5: must exit 0 — see G5 note
RUNTIME.agents                                            # G6: agent state all "done"; interrupted false
```

**G2b exists because `--untracked-files=all` does not show ignored files, and in this repo
gitignored does not mean worthless** — `agent-orchestrator.yaml` and
`.claude/skills/*/local.config.json` are both gitignored operator config. The grep is a
**closed allowlist of provably disposable build artefacts**; anything ignored outside it
stops teardown and goes to the operator. Never widen that list by judging at runtime
whether a file "looks like junk" — add a root to the allowlist deliberately or stop.

Stop conditions, verbatim — on any of these, **abort teardown, report, leave everything
running**. No `--force`, no retry, no partial teardown:

1. **G1** branch drifted between resolution and action. `git -C "$WP" symbolic-ref -q --short HEAD`
   must equal `$HEAD_REF`. **Detached case:** on a detached HEAD this command exits non-zero and
   prints nothing, so a worktree the operator explicitly confirmed at R3 could never pass — its
   processes would leak forever. When (and only when) the operator confirmed a detached row at R3,
   substitute an identity check that works: `git -C "$WP" rev-parse HEAD` must equal the runtime
   row's `head` recorded at 9a, and that commit must be contained in `origin/main`. Record in the
   report that the detached path was used.
2. **G2** uncommitted or untracked work exists in the worktree. (Rule zero.)
3. **G3** commits exist locally that are not on `origin/main`. Test the **worktree's
   branch**, not the PR: a squash/rebase merge or a post-merge commit in the worktree
   breaks containment even though `MERGE_SHA` is on `origin/main`.
4. **G5** the branch is not an ancestor of `origin/main`.
   **Squash/rebase caveat:** if Step 5 used `--squash`/`--rebase` (only ever on explicit user
   request), the branch's commits are *not* ancestors of the resulting commit, so G5 fails by
   design — and `git branch -d` in 9f would fail too, leaving worktree and branch behind and
   defeating this cleanup. Do **not** loosen G5. Instead prove equivalence: `gh pr view P --json
   state` must be `MERGED` **and** the worktree's tree must already be contained in `origin/main`
   (`git -C "$WP" diff --quiet origin/main` exits 0). Only then continue, use `git branch -D` in
   9f for this case alone, and name the squash/rebase path verbatim in the report. Tree not
   contained → **stop**.
5. **G6** any agent `state !== "done"`, or `interrupted: true`. **Never kill a running agent as a
   merge side effect** — stop and ask. Select the row **exactly**: the single `RUNTIME.agents`
   row whose worktree path equals `WP` (the command is global across repos — filtering is
   mandatory, and a global "any agent busy anywhere" reading is wrong). Zero or multiple matching
   rows → **refuse** (state desync). Freshness: treat the row as busy if it produced output within
   the last 120 s, measured from the runtime's last-output timestamp; if the active runtime exposes
   no such field, say so in the report and rely on `state`/`interrupted` alone — never invent a
   substitute signal.
6. `WP` is a main checkout or the operator's own current worktree → **refuse**.

**Note — there is deliberately no stash gate.** Git stores stashes per *repository*, not per
worktree (`refs/stash` lives in the shared git dir), so `git -C "$WP" stash list` shows every
stash in the repo — 36 of them on the current operator host. Gating on an empty stash list would
block every teardown forever while protecting nothing, and the premise that stashes die with the
worktree is simply false: they survive `worktree rm`. Report the stash count if you like; never
block on it.

### 9c — Stop terminals, then close tabs

```bash
RUNTIME.stop_terminals("$WP")
RUNTIME.terminals_all > "$RUN_DIR/terms.json"   # GLOBAL census — the tab guard needs every tab
RUNTIME.terminals("$WP")                        # → remaining handles for this worktree
```

For each remaining handle `H` with tab `T`, decide from the **global** census:

- every terminal whose tab is `T` has worktree path `$WP` → `RUNTIME.close_tab("$H")`;
- the tab is **mixed** (any terminal on `T` belongs elsewhere) → `RUNTIME.close_pane("$H")`,
  never `close_tab` — closing the tab would take another worktree's terminal down with it.

```bash
RUNTIME.terminals("$WP")            # must be empty before 9d
```

If a mixed tab cannot be reduced to empty by pane-closes, **stop** and report — do not fall back
to `close_tab`. Fail closed rather than destroy a bystander's terminal.

The tab guard is load-bearing: `--tab` closes the whole tab, so a tab holding panes from
another worktree would take that worktree's terminal down with it. Verify tab membership
before closing; if a tab is mixed, close the pane without `--tab`.

Terminals stop **before** the reap because the worktree's PTY leader is a child of the
Orca daemon — SIGTERMing it under a live PTY invites a reincarnation race (terminal rows
carry `incarnationId` and `orphaned`, which implies respawn semantics).

### 9d — Reap the process tree

**ABA guard first.** `/proc` carries a textual path with no incarnation identity, so if a
*previous* worktree at this same path left orphans behind, they are indistinguishable from
the current one's processes:

Build the neutral inventory once (see Runtime profile), then:

```bash
REAP=".claude/skills/merge-with-local-adoption/reap-worktree.mjs"
RT="$RUN_DIR/rt-worktrees.json"    # produced by the Runtime profile snippet, private dir

node "$REAP" --runtime-worktrees "$RT" --scan-orphans --json \
  | grep -F "$WP"     # any hit ⇒ a dead namesake's orphans share this path ⇒ STOP, ask the operator
```

```bash
node "$REAP" --runtime-worktrees "$RT" --path "$WP"                  # DRY RUN first
node "$REAP" --runtime-worktrees "$RT" --path "$WP" --apply --json
```

**Show the dry-run set to the operator before applying.** The reaper selects by CWD +
descendant closure, refuses any target outside the Orca workspaces root or any main
checkout, immunizes the operator's own process chain, excludes sibling worktrees, escalates
SIGTERM → 10 s → SIGKILL, revalidates each PID's start time before signalling (PID-reuse
guard), and re-scans `/proc` from scratch to verify.

**`--apply` must exit 0.** A non-zero exit means processes survived: **stop with the
worktree intact** and hand the operator a live, inspectable directory. Never proceed to
`rm` with a dirty residual — that is exactly how the existing 37 orphans were created.

### 9e — Re-verify, then remove the worktree

**Re-run the G2/G3 checks before `rm`.** A SIGKILL can land mid-write and leave an
`index.lock` or a half-written file, so cleanliness proven *before* the reap is not
cleanliness *after* it:

```bash
git -C "$WP" symbolic-ref -q --short HEAD                 # must STILL equal $HEAD_REF (re-check G1)
git -C "$WP" status --porcelain --untracked-files=all     # must still be EMPTY
git -C "$WP" log --oneline origin/main..HEAD              # must still be EMPTY
RUNTIME.worktrees                                         # row for $WP must still exist, same branch
```

Re-checking **G1 and the runtime row**, not just cleanliness, is the point: terminals were stopped
and up to ~11 s of SIGTERM/SIGKILL elapsed since 9b, and in that window another actor could have
switched `$WP` onto a different — also clean, also merged — branch. G2/G3 alone would stay green
and you would delete a worktree that no longer matches `HEAD_REF`.

Dirty now → **leave the worktree in place** with its processes already stopped, and report.
The merge stands; only teardown is blocked.

```bash
RUNTIME.remove_worktree("$WP")
```

No force flag (the 9b gate is what authorizes this; forcing would paper over a gate you
should have obeyed).

**Never run the runtime's archive/removal hooks** (`--run-hooks` on the active runtime). It executes `orca.yaml` archive hooks — repo-defined code from a
branch-local checkout — as the operator, immediately after merging that branch. That is an
arbitrary-code-execution path a PR author could control. The repo has no `orca.yaml` today,
but the prohibition is about the trust boundary, not the current file list: do not pass the
flag even if one appears.

### 9f — Delete the local branch

`gh pr merge --delete-branch` removed only the remote ref. Git refuses to delete a branch
still checked out in a worktree, so this must come after 9e:

```bash
git branch -d "$HEAD_REF"
```

**`-d`, never `-D`** — `-d` performs its own merged-ness check, so a divergence appearing
between G5 and here still fails safe.

### 9g — Post-check and orphan census

```bash
RUNTIME.worktrees                        # no row for $WP
RUNTIME.terminals("$WP")                 # empty
ls -d "$WP" 2>/dev/null && echo "RESIDUE: directory still present"
node "$REAP" --runtime-worktrees "$RT" --scan-orphans     # refresh $RT first
```

The census is **report-only — never sweep as part of a merge.** Pre-existing orphans belong
to worktrees the operator did not name in this run, and an orphan is not provably garbage:
the pack deliberately `setsid`-detaches long-running jobs so terminal teardown will not
kill them, and at least one current orphan group is holding a live test run. Killing it
mid-merge would break an unrelated task. Sweeping is a separate, explicitly-invoked
operator chore (`--scan-orphans` to inspect, then a per-worktree `--path … --apply` after
the operator confirms that group).

Report the count in Step 10 every run, so the debt stays visible instead of silently
growing.

### What this teardown does *not* guarantee

Say this plainly in the report rather than claiming a clean machine:

- **CWD + ancestry is inference, not ownership.** A process that chdir'd away, double-forked
  and reparented before teardown is unreachable by any post-hoc signal. On this host the
  inference is empirically complete (descendant and pgid/sid closure add zero processes),
  but that is an observation, not a proof. The durable fix is launch-time containment —
  follow-up 2 below.
- **A clean `git status` does not prove no unsaved work** — an external editor may hold an
  unsaved buffer over a file in the worktree. Not automatically detectable.
- **Killing processes does not undo their side effects.** A reaped agent may already have
  posted GitHub comments or mutated remote state.

State teardown outcomes as one of: *reaped clean*, *blocked* (with the gate that stopped it),
or *partial* (with the residual). A blocked teardown after a successful merge is a correct,
reportable outcome — **never** describe the whole run as failed, and never retry by
loosening a gate.

## Step 10 — Final report (required, user's language)

```markdown
## Merge и локальная адаптация — отчёт
**PR:** #P — <title>  **Issue:** #I  **Merge commit:** <sha>
### Статусы (3a — если была прямая команда на мерж)
- Нормализовано: <draft→ready / update-branch / ничего не требовалось>
### Git
- Pull: <checkout+pull / merge origin/main / stash+pop / пропущен>; dirty на старте: да/нет
- Pre-flight пути сохранены: да / <исключения>; stash: <state>; запрещённые команды не использовались
- MERGE_SHA в HEAD живого чекаута (6e): да/нет
### Adoption
- Выполнено: <список>  /  Не требовалось  /  Осталось оператору: <…>
### Соседние ворктри (8 — если RULES_TOUCHED)
- <name>: behind N, агент <state>, rules stale да/нет; recycle: <спросил/не требовалось/выполнен>
### Teardown воркдерева (9)
- Итог: **reaped clean / blocked (гейт G<N>) / partial (residual <n>)**
- Ворктри: <path> (branch <HEAD_REF>) / не найден — R3 спросил / пропущен: <причина>
- Гейт 9b: <пройден / стоп на G<N>: …>; ABA-проверка: <чисто/совпадение пути>
- Терминалы: stop <n>, close <n>; процессов снято: <n> (SIGKILL: <n>); residual: <0/…>
- Повторный git-чек перед rm: <чисто/грязно — rm не выполнялся>
- worktree rm: <ok/пропущен>; локальная ветка -d: <ok/пропущен>; residue: <нет/…>
### Сироты (9g — только учёт, не трогаем)
- <N> процессов в <M> удалённых воркдеревьях
### Проверка
- `git status --short` / `git log -1 --oneline`: <…>
```

Never claim CI/adoption/teardown succeeded without the commands actually run.

## Do not

- Merge or run teardown while a Step 3b worker fix is in flight; skip the adoption scan
  because CI is green; skip Step 9 after a successful merge.
- Apply Step 3a normalization without a direct user merge order, attempt `--admin` past
  required CI that is not green (`enforce_admins` refuses it anyway), or flip a draft to
  ready without then running the full adoption flow.
- `git push --force` to main; fix red CI from the architect session when a PR worker
  exists (unless `direct-fix-checklist` authorized).
- Reap or remove a worktree resolved by anything other than exact branch equality (9a R2)
  or an explicit operator answer (9a R3). Never by `displayName`, issue-number substring,
  `active`, or `current`.
- Kill any process by name or command line, or run the reaper against a path outside the
  Orca workspaces root. Never `orca worktree rm --force`, never `rm -rf` a worktree.
- Auto-recycle a sibling manager worktree (Step 8), or sweep pre-existing orphans as part
  of a merge (Step 9g).
- Port AO procedures — `ao session kill/restore/cleanup`, ProjectConfig, the orchestrator
  runtime-worktree probe, `wait-orchestrator-launch.ps1`. The daemon is gone; these fail.

## Follow-ups this skill cannot fix (open issues for the queue)

1. **Worktree creation does not set `linkedPR`/`linkedIssue`.** `orca worktree set
   --worktree <sel> --issue <N>` exists but nothing calls it, which is why 9a must join on
   branch and why detached worktrees resolve to nothing. Setting it at creation makes 9a R1
   live and `issue:<n>` a real selector.
2. **Agents are not launched in a dedicated cgroup.** A per-worktree
   `systemd-run --user --scope` at spawn time would make teardown exact by kernel-maintained
   ownership instead of CWD inference, and would catch a process that chdir'd away before
   teardown. Only Orca's spawn path can do this; the reaper is a best-effort cleanup for
   agents it did not launch.
3. **The runtime-neutral contract has no worktree lifecycle.**
   `scripts/runtime/contracts.ts` (`RuntimeAdapter`, composition root `selectRuntimeAdapter`
   in `scripts/runtime/registry.ts`) exposes only worker/terminal operations, and deliberately
   refuses destructive close (`runtime_generation_bound_stop_unsupported`). Teardown therefore
   cannot route through it yet, which is why this skill carries a Runtime profile table.
   **Durable fix:** extend `RuntimeAdapter` with worktree list/inspect/remove plus a
   generation-bound terminal stop, implement them in the Orca adapter, and collapse the profile
   table to `selectRuntimeAdapter()`. Until then the profile table is the single swap point —
   do not let a rival runtime abstraction grow inside this skill.
