---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely pull main in the live checkout, and apply documented
  local operator adoption. After every merge, verify the AO orchestrator runtime
  worktree contains the merge commit (Step 6e); for runtime-sensitive merges, recycle
  affected AO sessions and confirm adoption surfaces (Step 8). After merge, kill the merged PR's
  worker AO session and run ao session cleanup -p orchestrator-pack. Use when the user asks to merge
  a finished task — e.g. «мерж», «мерж 385», «мерж и пул», «смерж», «merge»,
  «merge and pull» — or clearly wants a ready PR merged after review/CI. When CI is red and/or the branch is behind base,
  delegate the fix to the PR worker (Step 3b) and resume merge + local adoption
  only after CI is green. Operates on the operator's live working tree in
  Cursor; never discards uncommitted local work. Skip when the user only asks
  about merge policy without a concrete PR.
---

# Merge with local adoption (Cursor)

When the user asks to merge a **ready** task/PR, run this workflow end-to-end in
**Cursor** on the operator's **live checkout**. Do **not** delegate merge or adoption
to `opencode run`, `opencode-publish.sh`, or DeepSeek.

Goal: merge the PR → update local `main` when needed → apply post-merge local steps
from the issue/PR → for runtime-sensitive merges, update AO ProjectConfig / recycle the
affected AO session from the **operator terminal** and confirm the orchestrator runtime worktree is on the merged commit →
kill the merged PR's worker session and run project session cleanup → **always**
probe the orchestrator runtime worktree commit after merge (Step 6e) → report exactly what changed.

**OpenCode terminal sessions** use
[`.claude/skills/opencode-merge-and-pull/SKILL.md`](../opencode-merge-and-pull/SKILL.md)
instead (same safety rules, different entrypoint).

**Managed-session guard:** run AO session lifecycle commands and worktree probes only
from the **operator terminal** (this Cursor skill). AO-managed worker sessions MUST NOT
run lifecycle or git commands inside AO worktrees (`AGENTS.md`).

---

## Triggers

Best-effort match (Russian or English):

- «мерж», «мерж и пул», «смерж», «смержи», «замержи»
- «мерж 385», «смерж #42», «merge 307», «merge and pull 307»
- «merge», «merge and pull», «merge the PR»

Optional number `N` is an issue or PR number (resolve in Step 2).

**Skip** when the user is only discussing merge strategy, branch protection, or
hypotheticals — no concrete PR to merge.

---

## Rule zero — never destroy local work

Before **any** git command after the pre-flight snapshot, obey this list.

### FORBIDDEN (never run)

- `git reset --hard` (any ref)
- `git clean -fd` / `git clean -fdx`
- `git checkout -- .` / `git restore .` / `git restore --staged --worktree .`
- `git switch -f` / `git checkout -f`
- `git stash drop` / `git stash clear`
- `git pull --rebase` on a dirty tree
- `git pull --autostash` unless you will `git stash pop` in the same run and
  report the outcome — prefer no autostash
- Replacing live `agent-orchestrator.yaml` wholesale from `.example`
- Deleting or overwriting files the user had as modified/untracked unless the
  issue explicitly says to remove that path **and** the user named the task
- `opencode run`, `opencode-publish.sh`, or nested agent delegation for merge/pull
- **Inside the AO-managed orchestrator worktree** (`~/.agent-orchestrator/projects/orchestrator-pack/worktrees/<session-id>/`):
  `git reset`, `git checkout` / `git switch`, `git clean`, manual file edits to adopt merged
  content, or `git worktree remove` — **except** the sanctioned clean fast-forward in
  **Step 6e** (`git fetch` + `git pull --no-rebase origin main` when behind `origin/main`)
- Manually deleting the AO worktree directory — use documented recovery scripts only

### REQUIRED

1. Run the **pre-flight snapshot** (Step 1) and keep its output for the final
   report.
2. After every git step, re-run `git status --short` and confirm no tracked file
   disappeared from the dirty list without an explicit, reported reason.
3. If a git command would fail because of local changes — **stop and report**;
   do not “fix” by discarding changes.
4. Prefer `git fetch` + explicit `git merge` over exotic pull flags.

---

## Step 1 — Pre-flight snapshot (mandatory)

Run and **save the output**:

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short
git diff --stat
git diff --cached --stat
git stash list
```

Record repo root, current branch, every modified/staged/untracked path, and
whether the tree is dirty. If `git status --short` is non-empty, note: **dirty
tree — use safe pull only (Step 6).**

---

## Step 2 — Resolve the PR

Let `N` be the user’s number when they named one (e.g. «мерж 385»).

Resolve in order:

1. If `N` given: `gh pr view N --repo chetwerikoff/orchestrator-pack --json number,title,body,state,mergeable,headRefName,baseRefName,url`
   — if this works, `N` is the PR number `P`.
2. Else if `N` given: open PR for issue `N`:
   `gh pr list --repo chetwerikoff/orchestrator-pack --state open --search "N" --json number,title,body,headRefName`
   — prefer PR whose body contains `Closes #N` / `Fixes #N` / `Resolves #N`.
3. Else: open PR for the current branch:
   `gh pr view --json number,title,body,state,mergeable,statusCheckRollup,url`
4. Else: PR the user named by URL or branch name.
5. If zero or multiple PRs match, **ask once** — do not guess.

Record: PR number `P`, title, linked issue `I` from PR body (`Closes #N` /
`Fixes #N` / `Resolves #N`).

---

## Step 3 — Confirm merge readiness

Unless the user explicitly waives checks:

```bash
gh pr checks P --repo chetwerikoff/orchestrator-pack
gh pr view P --repo chetwerikoff/orchestrator-pack --json mergeable,reviewDecision,state,statusCheckRollup
```

Stop without merging if:

- `state` is not `OPEN`
- `mergeable` is not `MERGEABLE` (offer `gh pr update-branch P` first if behind)
- Required checks are failing or review is blocking

Optional when AO review is in play: `ao review list orchestrator-pack --json` for
the PR head — do not merge on open/sent findings or empty failed runs (see
`AGENTS.md`).

---

## Step 3b — Worker handoff when CI or base sync is blocked

When Step 3 finds **any** of:

- One or more checks failing (`gh pr checks P` shows `fail`)
- Branch not up to date with base (`mergeStateStatus` is `BEHIND`, or strict
  protection blocks merge until `gh pr update-branch P`)
- **Both** (common after `main` moved while CI was red)

**Stop before Step 4.** Do **not** patch worker-scope implementation on the PR
branch from the architect Cursor session (declaration snapshots, vitest lane
classification, `verify.ps1` guards, scripts/tests on the PR diff). Delegate to
the PR worker when one is available; **resume merge and local adoption only
after** the worker unblocks CI and the branch is sync-ready.

### 3b-i — Resolve worker session

```bash
ao session ls
gh pr view P --repo chetwerikoff/orchestrator-pack --json headRefName,body
```

Derive linked issue `I` from the PR body (`Closes #I`, `Fixes #I`, …). Find a
worker session where `role` is `worker` or `coding` and `issue == I` (or the
session display name / branch matches the PR head).

| Outcome | Action |
|---------|--------|
| Worker found (`idle` or `working`) | → 3b-ii |
| No worker, task was AO-spawned | Report blocker; offer `ao spawn` only if the user asks to unblock |
| User explicitly authorized architect direct fix | `direct-fix-checklist` — exception only |

### 3b-ii — Send fix task (do not merge yet)

Collect failure evidence before sending:

```bash
gh pr checks P --repo chetwerikoff/orchestrator-pack
gh pr view P --json mergeStateStatus,statusCheckRollup
# For each failing job, skim:
gh run view <run-id> --log-failed
```

```bash
ao send --session <W> --message "<task>"
```

The message must include:

- PR `P`, branch name, linked issue `I`
- Failing check names and the top actionable log lines (scope guard, vitest
  `classification-required`, `verify.ps1` guard names, etc.)
- If the branch is behind base: worker must land fixes **and** sync with `main`
  (`git merge origin/main` / rebase per project norm, or `gh pr update-branch P`
  after push) so strict protection can pass
- Explicit: **do not merge** — architect resumes this skill at Step 3 when CI is
  green

Record handoff: worker session id, UTC time, checks that were red.

### 3b-iii — Wait, then resume merge workflow

Poll from the operator session:

```bash
gh pr checks P --repo chetwerikoff/orchestrator-pack
gh pr view P --json mergeStateStatus,mergeable,statusCheckRollup
```

Resume at **Step 3** (re-run readiness) when:

- No failing checks (required contexts green per branch protection)
- Branch is not `BEHIND` base (run `gh pr update-branch P` from the operator
  session if the worker fixed code but GitHub still shows behind)
- `mergeStateStatus` is merge-ready (`CLEAN` or acceptable `UNSTABLE` with zero
  failures — not blocked on sync)

Then continue **Step 4 → 10** in order: collect adoption → merge → safe pull →
operator adoption → runtime verification (if any) → worker teardown → report.

**Order invariant:** worker fixes land first; **merge and local adoption always
run after** CI is green — never in parallel with an in-flight worker fix.

If the worker finishes idle but CI is still red, send a follow-up `ao send` with
the remaining failures or escalate to the user.


---

## Step 4 — Collect local adoption instructions and classify runtime-sensitive

Read **all** of these before merging:

| Source | Command / action |
|--------|------------------|
| PR body | `## Operator adoption` section |
| PR diff paths | `gh pr diff P --name-only` |
| PR diff content | `gh pr diff P` for `.example`, runbooks, env docs |
| Linked issue `I` | `gh issue view I --json body` — Operator adoption / Binding surface |
| Issue draft | `docs/issues_drafts/` row from `docs/issue_queue_index.md` if body is thin |
| Migration notes delta | `migration_notes.md` hunks in the PR diff |

**Operator-facing surfaces** (any change ⇒ likely local work):

- `agent-orchestrator.yaml.example` / `agent-orchestrator.yaml` — AO 0.10.2 does **not**
  read these as live runtime config after legacy import; YAML rules/reactions/notifiers are
  documentation or migration inputs only unless a current adoption note names a supported
  `ao project set-config` change.
- `orchestratorRules`, `reactions`, `notifiers`, `notificationRouting` — legacy YAML surfaces
  on AO 0.10.2; do **not** classify as runtime-sensitive by themselves.
- New/changed long-running scripts: `orchestrator-wake-listener.ps1`, trust watcher, heartbeat
- Documented env/PATH wiring: `PACK_REVIEWER`, PATH prepend, worker/orchestrator agent config,
  webhook URL/port. On AO 0.10.2 these live in per-project ProjectConfig via
  `ao project set-config`; changes apply when a session is spawned/restored, not on daemon restart.
- Machine-local CLI config (`~/.cursor/cli-config.json`) called out in docs
- Runbook/go-live changes: `docs/orchestrator-autoloop-go-live.md`, `docs/orchestrator-wake-runbook.md`, `docs/orchestrator-recovery-runbook.md`, `docs/reviewer-switch-runbook.md`
- Anything requiring long-running pack processes or AO sessions to be respawned

### Runtime-sensitive classification

Set **Runtime-sensitive: yes** when the PR diff (or adoption text) touches any of:

| Signal | Examples |
|--------|------------|
| Worker/orchestrator prompts | `prompts/**` — pack prompt delivery on AO 0.10 is under migration in Issue #625; do not invent a delivery mechanism |
| Autonomous bash surface | `scripts/autonomous-*` |
| Orchestrator side processes | wake listener, heartbeat, trust watcher, `orchestrator-wake-supervisor.ps1`, `wait-orchestrator-launch.ps1` |
| AO ProjectConfig wiring | `PACK_REVIEWER`, PATH prepend, `--env`, `--worker-agent`, `--orchestrator-agent`, `agentConfig.env` adoption mapped to `ao project set-config` |
| Long-running pack processes | wake listener, heartbeat, trust watcher, supervised children whose process command/env must change |
| Explicit session recycle | adoption or `migration_notes.md` requires respawning an AO session or supervised process |

**Legacy YAML-only changes are not runtime-sensitive on AO 0.10.2 by themselves:**
`agent-orchestrator.yaml.example`, live `agent-orchestrator.yaml`, `orchestratorRules`,
`reactions`, `notifiers`, and `notificationRouting` are ignored by the AO 0.10 runtime
unless the adoption text maps them to a supported ProjectConfig/process change.

**Runtime-sensitive: no** (skip Step 8) when **all** of:

- Diff is docs / tests / `plugins/**` only, **and**
- No operator-process, `prompts/**`, `scripts/autonomous-*`, ProjectConfig/env/PATH wiring,
  or long-running process changes, **and**
- PR body says `No operator adoption required` or equivalent, **and**
- Nothing in adoption text requires session respawn, process restart, or ProjectConfig update

When unsure, treat as runtime-sensitive — under-adoption is worse than an unnecessary
session/process recycle.

Contract reference: Issue #101 (`docs/issues_drafts/35-operator-adoption-handoff-contract.md`).

### Brief pre-merge note (when adoption is needed)

Before merging, tell the user in one short block what local work you will apply
after pull (Russian or English matching the user). If no adoption: one line —

> Локальных настроек для этой задачи нет — мержу без post-merge шагов.

If runtime-sensitive, mention that Step 8 will apply supported AO 0.10 runtime adoption and verify the orchestrator
worktree commit after adoption.

---

## Step 5 — Merge the PR

Use GitHub — do **not** run local `git merge` of the PR branch:

```bash
gh pr merge P --repo chetwerikoff/orchestrator-pack --merge --delete-branch
```

Use `--squash` or `--rebase` only if the user asked in the same message.

Verify:

```bash
gh pr view P --repo chetwerikoff/orchestrator-pack --json state,mergedAt,mergeCommit
```

Record **merge SHA** from `mergeCommit.oid`. If merge fails, stop and report stderr;
do not retry with force.

---

## Step 6 — Safe pull in the live checkout

Run this step when the user asked for pull («мерж и пул», «merge and pull») **or**
when Step 4 adoption needs files from merged `main`. Skip only when the user
explicitly asked to merge without updating the local tree **and** no adoption
requires fresh `main` content.

Default branch: `main` (confirm with
`git symbolic-ref --quiet refs/remotes/origin/HEAD` or project docs).

### 6a — Fetch only first

```bash
git fetch origin
```

Record **origin/main SHA**: `git rev-parse origin/main`.

### 6b — If the tree was clean at pre-flight

```bash
git checkout main
git pull --no-rebase origin main
```

### 6c — If the tree was dirty (most common — follow strictly)

**Do not** `git checkout main` if it would overwrite tracked modifications.
Check first:

```bash
git checkout main 2>&1 || true
```

- If checkout **refused** because of local changes: stay on the current branch,
  or create/update `main` without discarding work:

```bash
git fetch origin
git branch -f main origin/main   # only if you are NOT on main; updates ref only
git merge --no-edit origin/main
```

- If you **must** be on `main` for adoption edits and checkout is blocked:

```bash
STASH_MSG="merge-with-local-adoption preserve $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git stash push -u -m "$STASH_MSG"
git checkout main
git pull --no-rebase origin main
git stash pop
```

After `stash pop`: if conflicts, **leave the stash entry** (`git stash list`),
report conflicted paths, and **do not** `git stash drop`.

- If checkout succeeds and the tree is still dirty (uncommitted changes carried
  onto `main`):

```bash
git pull --no-rebase origin main
```

If pull refuses because local changes would be overwritten: **stop**. Report the
conflicting paths from git’s message. Offer the stash path above only after
telling the user what will be stashed.

### 6d — Post-pull verification

```bash
git status --short
git log -1 --oneline
```

Compare to Step 1 snapshot — every path that was modified/staged/untracked
before must still exist or be accounted for. **Never** use
`git reset --hard origin/main` to “sync”.

---
### 6e — Orchestrator worktree commit probe (mandatory after merge)

Step 6 updates only the **operator live checkout**. The AO **orchestrator runtime worktree**
(`~/.ao/data/worktrees/orchestrator-pack/orchestrator/orchestrator-orchestrator/` on AO
0.10.2 — often **not** `$WT_BASE/<session-id>/`) is a separate clone — it does **not**
auto-sync on `git pull` in the pack root. `ao session restore` also does **not** fast-forward
it to `main` (verified AO 0.10.2, 2026-07-07). After every successful merge, probe and
sync via this step even when Step 8 is skipped (non-runtime-sensitive PRs).

**Do not confuse with recovery runbook Step 2b → Step 3:** that path removes stale
`orchestrator/*` branches/worktrees for `branch_collision` / `EPERM` only. It does **not**
pull `origin/main` into a live orchestrator worktree that is merely behind `main`.

**Skip only when:** `ao orchestrator ls --json` has no non-terminated
`projectId == "orchestrator-pack"` row and `ao session ls --json -p orchestrator-pack --all`
has no non-terminated `role/kind == "orchestrator"` row.

#### Resolve orchestrator session id and worktree (Steps 6e / 8)

Fail closed — resolve from env or live AO 0.10 session/orchestrator lists only; **never**
guess a default id. `ao status --json` is daemon health only on AO 0.10.2 and must not
be parsed for sessions.

```bash
P=orchestrator-pack
AO_DATA="${AO_DATA:-$HOME/.ao/data}"
WT_BASE="$AO_DATA/worktrees/$P"

resolve_orchestrator_session_id() {
  if [ -n "${AO_ORCHESTRATOR_SESSION_ID:-}" ]; then
    printf '%s\n' "${AO_ORCHESTRATOR_SESSION_ID}"
    return 0
  fi
  local orch_json session_json err
  err="$(mktemp)"
  if ! orch_json="$(ao orchestrator ls --json 2>"$err")"; then
    echo "Step 6e aborted: ao orchestrator ls failed: $(cat "$err")" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  if printf '%s' "$orch_json" | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(input); } catch { process.exit(2); }
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const orch = rows.find((row) => row && row.projectId === "orchestrator-pack" && !row.isTerminated);
  if (!orch || !orch.id) process.exit(2);
  process.stdout.write(String(orch.id));
});
'; then
    return 0
  fi

  err="$(mktemp)"
  if ! session_json="$(ao session ls --json -p orchestrator-pack --all 2>"$err")"; then
    echo "Step 6e aborted: ao session ls failed: $(cat "$err")" >&2
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  printf '%s' "$session_json" | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(input); } catch { process.exit(2); }
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const orch = rows.find((row) => row && (row.role === "orchestrator" || row.kind === "orchestrator") && !row.isTerminated);
  if (!orch || !orch.id) process.exit(2);
  process.stdout.write(String(orch.id));
});
' || {
    echo "Step 6e aborted: orchestrator session id not found in ao orchestrator/session lists" >&2
    return 1
  }
}

resolve_orchestrator_worktree_path() {
  local s="$1"
  local candidate wt
  for candidate in \
    "$WT_BASE/orchestrator/orchestrator-$s" \
    "$WT_BASE/orchestrator/orchestrator-orchestrator" \
    "$WT_BASE/orchestrator" \
    "$WT_BASE/$s"; do
    if [ -d "$candidate/.git" ] || [ -f "$candidate/.git" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  wt="$(git worktree list --porcelain 2>/dev/null | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^worktree (.+)$/);
    if (!m) continue;
    const path = m[1];
    let branch = "";
    if (lines[i + 2] && lines[i + 2].startsWith("branch ")) {
      branch = lines[i + 2].slice("branch refs/heads/".length);
    }
    if (
      path.includes("/worktrees/orchestrator-pack/orchestrator/") ||
      branch === "ao/opk-orchestrator" ||
      branch.startsWith("orchestrator/")
    ) {
      process.stdout.write(path);
      process.exit(0);
    }
  }
  process.exit(2);
}')"
  if [ -n "$wt" ]; then
    printf '%s\n' "$wt"
    return 0
  fi
  echo "Step 6e aborted: orchestrator worktree path not found under $WT_BASE" >&2
  return 1
}
```

#### Probe and sync (operator pack root — not inside `$WT` for the live-checkout pull)

```bash
git fetch origin
ORIGIN_MAIN="$(git rev-parse origin/main)"
MERGE_SHA="<from Step 5 mergeCommit.oid>"

S="$(resolve_orchestrator_session_id)" || { echo "Step 6e: no orchestrator session — skipped"; exit 0; }
WT="$(resolve_orchestrator_worktree_path "$S")" || exit 1
WT_HEAD="$(git -C "$WT" rev-parse HEAD 2>/dev/null || echo MISSING)"
WT_BRANCH="$(git -C "$WT" branch --show-current 2>/dev/null || echo MISSING)"

# Required: worktree must contain the merge commit (not merely an older ancestor of main)
git merge-base --is-ancestor "$MERGE_SHA" "$WT_HEAD"
WT_CONTAINS_MERGE=$?

git merge-base --is-ancestor "$MERGE_SHA" "$ORIGIN_MAIN"
ORIGIN_CONTAINS_MERGE=$?
```

**Pass without sync** when `WT_CONTAINS_MERGE=0` **and** `ORIGIN_CONTAINS_MERGE=0` (ideal:
`WT_HEAD` equals `ORIGIN_MAIN`).

**If `WT_CONTAINS_MERGE` ≠ 0** (stale orchestrator worktree — common after merge+pull):

1. Check worktree cleanliness: `git -C "$WT" status --porcelain` must be empty.
2. If clean, sanctioned fast-forward from the **operator terminal**:

```bash
git -C "$WT" fetch origin main
git -C "$WT" pull --no-rebase origin main
WT_HEAD="$(git -C "$WT" rev-parse HEAD)"
git merge-base --is-ancestor "$MERGE_SHA" "$WT_HEAD"
```

3. Re-record `WT_HEAD` / `WT_BRANCH`. Pass when the final `merge-base` check exits 0.

**If worktree is dirty, pull fails, or still stale after fast-forward:**

- **Do not** `reset`, `checkout`, or `clean` inside `$WT`.
- Run `orchestrator-worktree-preflight.ps1` only when spawn logs show
  `branch_collision` / `EPERM` — **not** when the only symptom is behind `main`.
- Classify the merge as **runtime-sensitive retroactively** and run **Step 8** after any
  successful Step 6e sync (session recycle + launch health).
- If still stale: escalate `docs/orchestrator-recovery-runbook.md` Step 2b → Step 3 for
  collision/EPERM hygiene, then **re-run Step 6e fast-forward** — restore alone is insufficient.
- Record expected (`MERGE_SHA`, `ORIGIN_MAIN`) vs actual (`WT_HEAD`) in the final report.

**Optional after successful sync:** when `ao orchestrator ls --json` shows a non-working
orchestrator but `$WT` is current, run `ao session kill "$S" -p orchestrator-pack`, then
`ao session restore "$S" -p orchestrator-pack`, and
`pwsh -NoProfile -File scripts/wait-orchestrator-launch.ps1 -OrchestratorSessionId "$S"`.
This is **not** a substitute for Step 8 when the merge was runtime-sensitive.

Record `S`, `WT`, `WT_HEAD`, `WT_BRANCH`, sync action (none / fast-forward / escalated) for
Step 10 — even when Step 8 is skipped.


## Step 7 — Apply local operator adoption

Execute only steps documented in Step 4. Rules:

1. **Surgical edits** — change only files and keys the adoption section names.
2. **`agent-orchestrator.yaml` / `.example`** — AO 0.10.2 does not reload these as live
   runtime config. Do not edit live YAML for runtime adoption unless the PR explicitly
   asks for a documentation/legacy-import update; map live env/PATH/agent changes to
   `ao project set-config` instead.
3. **Do not commit** live yaml, secrets, or machine-local config unless the user
   explicitly asked to commit in the same message.
4. **Listener scripts, supervised children, `PACK_REVIEWER` / PATH changes:** defer
   process/session recycling to Step 8 when the merge is runtime-sensitive; otherwise run
   only when the adoption section requires it outside Step 8.
5. Call out separate terminals (AO, wake listener, trust watcher) when docs
   require them.
6. Do not invent secrets or ports — copy defaults from the PR/docs.
7. If adoption is ambiguous, apply the minimal safe change and list open
   questions in the report — do not guess destructive steps.

After edits:

```bash
git status --short
```

Confirm pre-existing dirty files are still present.

---

## Step 8 — Runtime adoption verification (runtime-sensitive only)

Skip when Step 4 classified **Runtime-sensitive: no**.

AO 0.10.2 facts this step relies on:

- `agent-orchestrator.yaml` is not a live runtime config. AO 0.10 reads per-project
  ProjectConfig from the daemon store (`ao project get/set-config`); YAML
  `orchestratorRules`, `reactions`, `notifiers`, and `notificationRouting` are ignored
  after legacy import.
- Project operands to `ao stop` / `ao start` are invalid. `ao start` has no project
  operand and opens the desktop app; it is not the pack's headless
  session-reload primitive.
- Env/PATH/agent changes apply when AO creates/restores a tmux/session. Apply supported
  config with `ao project set-config`, then recycle the affected session(s).
- Pack prompt delivery on AO 0.10 is under migration in Issue #625. For `prompts/**`,
  verify only that the runtime worktree contains the merged prompt files; do not claim
  AO prompt injection is proven until #625 defines the delivery mechanism.

Canonical references — do **not** invent parallel worktree/git procedures:

| Need | Canonical doc / script |
|------|------------------------|
| ProjectConfig/env/PATH adoption | `ao project set-config orchestrator-pack --env KEY=VALUE ... --json`; config resolves when sessions spawn/restore |
| Orchestrator worktree behind `main` after merge | **Step 6e** fast-forward (`git -C "$WT" pull --no-rebase origin main` when clean) — **not** runbook Step 2b alone |
| Stale `orchestrator/*` branch / `branch_collision` / `EPERM` before recycle | `docs/orchestrator-recovery-runbook.md` — **Step 2b**; `scripts/orchestrator-worktree-preflight.ps1` |
| Launch health after orchestrator restore | `scripts/wait-orchestrator-launch.ps1` (recovery runbook Step 3) |
| Fresh runtime/prompt delivery semantics | [`.claude/skills/change-orchestrator-runtime/SKILL.md`](../change-orchestrator-runtime/SKILL.md) and Issue #625; do not improvise |
| Merged PR review-loop policy (not worktree repair) | `docs/orchestrator-recovery-runbook.md` — **After manual PR merge** |
| Journaled worker-send adoption | Currently fail-closed on AO 0.10.2 because `ao send` requires `--session`/`--message` and removed `--file`; see Step **8e** |

**Journaled worker-send adoption (Step 8e):** do not require the old adoption proof on
AO 0.10.2. The transport is intentionally fail-closed until the separate send-transport
migration lands; record the skip instead of blocking the merge on an impossible
`ao send --file` verification.

### 8a — Resolve orchestrator session id and worktree path

Reuse `resolve_orchestrator_session_id`, `P`, and `AO` from **Step 6e** (same shell session
if possible). If Step 6e was skipped because no orchestrator existed, fail closed here when
Step 4 required runtime-sensitive adoption.

```bash
S="$(resolve_orchestrator_session_id)" || exit 1
WT="$(resolve_orchestrator_worktree_path "$S")" || exit 1
```

**Prerequisite:** Step 6e must have left `$WT` containing `MERGE_SHA` before recycle.
`ao session restore` does not fast-forward the worktree on AO 0.10.2.

Record `S` and `WT`. Re-run `resolve_orchestrator_session_id` in Step 8d after restore
when the id may have changed — still fail closed; do not substitute a guessed id.

### 8b — Pre-recycle baseline (mandatory)

Run and **save output** before any session recycle:

```bash
git fetch origin
ORIGIN_MAIN="$(git rev-parse origin/main)"
MERGE_SHA="<from Step 5 mergeCommit.oid>"
WT_BEFORE_HEAD="$(git -C "$WT" rev-parse HEAD 2>/dev/null || echo MISSING)"
WT_BEFORE_BRANCH="$(git -C "$WT" branch --show-current 2>/dev/null || echo MISSING)"
ao status --json
ao orchestrator ls --json
ao session get "$S" --json -p orchestrator-pack
```

### 8c — Apply supported runtime config and recycle affected sessions

If adoption requires env/PATH/agent changes, apply them to ProjectConfig first. Preserve
existing values by using the exact adoption instructions; do not clear unrelated config.
Examples of supported AO 0.10.2 shapes:

```bash
ao project set-config orchestrator-pack --env PACK_REVIEWER=codex --json
ao project set-config orchestrator-pack --orchestrator-agent cursor --json
ao project set-config orchestrator-pack --worker-agent cursor --json
```

Only run `ao project set-config` when Step 4 found an actual ProjectConfig adoption
requirement. If the runtime-sensitive change is only a long-running pack process, restart
that process per its runbook and skip ProjectConfig mutation.

If preflight reports stale orchestrator worktree/branch items, follow recovery runbook
**Step 2b** first (read-only check, then `-Apply` only as documented there — not ad-hoc
`git worktree remove`):

```bash
pwsh -NoProfile -File scripts/orchestrator-worktree-preflight.ps1 -OrchestratorSessionId "$S"
# If findings and runbook says apply:
pwsh -NoProfile -File scripts/orchestrator-worktree-preflight.ps1 -OrchestratorSessionId "$S" -Apply
```

Recycle the orchestrator session when the adopted runtime surface affects the
orchestrator session, ProjectConfig env/PATH/agent, or `prompts/**` worktree content:

```bash
ao session kill "$S" -p orchestrator-pack
ao session restore "$S" -p orchestrator-pack
pwsh -NoProfile -File scripts/wait-orchestrator-launch.ps1 -OrchestratorSessionId "$S" -ProjectId orchestrator-pack
```

For worker-only env/PATH changes, do not kill unrelated active workers just to prove
adoption. Record that ProjectConfig is updated and will apply to newly spawned/restored
workers; recycle only the specific worker if the adoption text requires it and the
operator confirms it is safe.

When adoption explicitly requires a runtime path that `set-config`/restore cannot cover,
stop and report a contract gap or defer to `change-orchestrator-runtime`; do not use
`ao stop` / `ao start <project>` as a substitute.

### 8d — Post-recycle worktree re-probe

Re-run `resolve_orchestrator_session_id` (Step 8a) if the orchestrator id may have
changed after restore — **stop Step 8** on failure; then:

```bash
S="$(resolve_orchestrator_session_id)" || exit 1
WT="$(resolve_orchestrator_worktree_path "$S")" || exit 1
WT_AFTER_HEAD="$(git -C "$WT" rev-parse HEAD 2>/dev/null || echo MISSING)"
WT_AFTER_BRANCH="$(git -C "$WT" branch --show-current 2>/dev/null || echo MISSING)"
ao status --json
ao orchestrator ls --json
ao session get "$S" --json -p orchestrator-pack
```

### 8e — Journaled worker-send adoption (AO 0.10.2 fail-closed)

Do **not** run the old canonical preflight on AO 0.10.2. It depends on
`ao send --file` / YAML `orchestratorRules` routing, while live AO 0.10.2 exposes only:

```bash
ao send --session <session-id> --message "<message>"
```

Record:

- **Journaled worker-send (8e): skipped — AO 0.10.2 send transport migration pending; old
  `--file`/YAML-routing proof is impossible and must fail closed.**
- If the merge itself changes send transport code, note that verification belongs to the
  separate transport-migration task; do not mark runtime adoption confirmed based on it.

You may still run non-send health checks that do not use removed AO flags/verbs, such as
`pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status`, but these
are health checks only and do not prove worker-send adoption.

### 8f — Success criteria

Report **runtime adoption confirmed** only when **all** hold:

1. **Commit (both checks required):**
   - Runtime worktree contains the merge commit:
     `git merge-base --is-ancestor "$MERGE_SHA" "$WT_AFTER_HEAD"` (exit 0), **or**
     `WT_AFTER_HEAD` equals `MERGE_SHA`.
   - `origin/main` contains the merge commit:
     `git merge-base --is-ancestor "$MERGE_SHA" "$ORIGIN_MAIN"` (exit 0).
   A pre-merge `WT_AFTER_HEAD` fails the first check even when it is an ancestor of
   `ORIGIN_MAIN` — stale heads before `MERGE_SHA` must **not** pass.
2. **Orchestrator alive:** `ao orchestrator ls --json` shows a non-terminated
   `projectId == "orchestrator-pack"` orchestrator session with healthy status, or
   `wait-orchestrator-launch.ps1` exited 0.
3. **Surfaces:** at least one runtime-sensitive path from Step 4 is present in the
   worktree at the expected content (spot-check: `git -C "$WT" show HEAD:<path>` or
   `test -f "$WT/<path>"` for a changed prompt/script named in the PR).
4. **Journaled worker-send:** record **8e skipped / fail-closed on AO 0.10.2** unless a
   later issue has migrated the send transport and updated this skill. This no longer
   blocks confirmation for unrelated runtime-sensitive merges.

Do **not** claim session recycle/adoption succeeded without recording `WT_AFTER_HEAD`.

### 8g — Stale worktree after recycle — stop and escalate

If `WT_AFTER_HEAD` is `MISSING`, or either commit check in 8f fails (worktree does not
contain `MERGE_SHA`, or `origin/main` does not contain `MERGE_SHA`):

- **Do not** run destructive git inside `$WT` or the live checkout to “fix” it.
- **Stop** Step 8; record **expected** (`MERGE_SHA` / `ORIGIN_MAIN`) vs **actual**
  (`WT_AFTER_HEAD`).
- Direct the operator to the documented recovery path:
  1. Re-run **Step 6e** fast-forward when `$WT` is clean (if not already tried)
  2. `docs/orchestrator-recovery-runbook.md` — Step 2b → Step 3 for `branch_collision` /
     `EPERM` only; then re-run Step 6e
  3. If prompt delivery remains stale after that: Issue #625 / `change-orchestrator-runtime`
- If no safe automated recreate path covers this scenario, note **contract gap** in the
  final report (do not improvise worktree deletion).

---

## Step 9 — Worker session teardown (mandatory)

Run from the **operator terminal** after Step 7 and after Step 8 when it ran (or
immediately after Step 7 when Step 8 was skipped). The merged PR's worker is
terminal — tear it down so stale worktrees and session records do not linger.

Canonical reference: `docs/orchestrator-recovery-runbook.md` — **After manual PR
merge** (merged PR workers are not review/ping targets).

### 9a — Resolve worker session id for PR `P`

Read from live AO state only — **never** infer a session id from the issue number,
branch name, or PR title.

```bash
WORKER_SESSIONS="$(ao session ls --json -p orchestrator-pack --include-terminated | jq -r --argjson pr "$P" '
  [.data[]
   | select((.role == "worker" or .role == "coding") and (.prNumber == $pr or .issueId == ($pr|tostring)))
   | select(.isTerminated != true)
   | .id] | unique | .[]')"
```

Interpretation:

| Result | Action |
|--------|--------|
| Exactly one id | Record as `W`; proceed to 9b |
| Zero ids | Record **worker session: not found**; skip 9b kill; still run 9c cleanup |
| Multiple ids | **Stop** — list candidates, ask operator once; do not guess |

**Hard guard:** `W` MUST NOT be an orchestrator session (`role/kind: orchestrator` in
`ao session get "$W" --json -p orchestrator-pack`). If the only match is
orchestrator-shaped, stop and report.

### 9b — Kill the worker session

When `W` is set:

```bash
ao session kill "$W" -p orchestrator-pack
```

Verify the session is gone:

```bash
ao session ls --json -p orchestrator-pack --include-terminated | jq -r --arg w "$W" '
  [.data[] | select(.id == $w and .isTerminated != true)] | length'
```

Expect **0**. If the session still appears, record the failure and continue to 9c
(do not retry kill in a loop).

### 9c — Project session cleanup

Remove other cleanup-eligible dead/closed-work sessions for this project:

```bash
ao session cleanup -p orchestrator-pack -y
```

Record stdout (which sessions were cleaned). **Do not** kill the orchestrator
session manually — cleanup targets eligible workers/reviewers only.

### 9d — Post-teardown check

```bash
ao session ls --json -p orchestrator-pack | jq -r '
  [.data[] | select(.role == "worker" or .role == "coding")
   | "\(.id)\tpr=\(.prNumber // .issueId // "-")\t\(.status)"] | .[]"'
```

Confirm no worker row still lists `prNumber == P`. Orchestrator row should remain.

---

## Step 10 — Final report (required)

Reply in the user’s language (Russian if they wrote Russian):

```markdown
## Merge и локальная адаптация — отчёт

**PR:** #P — <title> (<url>)
**Issue:** #I (если есть)
**Merge commit:** <sha или mergedAt>

### Git
- Ветка до / после: …
- Pull: <что выполнено — checkout main + pull / merge origin/main / stash+pop / пропущен>
- Dirty tree на старте: да/нет (<N> путей)

### Сохранность локальных файлов
- Пути из pre-flight, которые остались: …
- Stash: создан / не нужен / pop OK / pop с конфликтами (stash сохранён: …)
- **Запрещённые команды не использовались** (reset --hard, clean, restore ., stash drop, opencode delegation, git в AO worktree)

### Orchestrator worktree (Step 6e)
- **Probe:** выполнен / пропущен (нет orchestrator-сессии)
- **origin/main SHA:** <ORIGIN_MAIN>
- **merge SHA:** <MERGE_SHA>
- **Orchestrator session id:** <S / —>
- **Runtime worktree:** <WT> @ <WT_HEAD> (<WT_BRANCH>)
- **Sync:** не требовался / fast-forward pull / escalated → Step 8 или runbook
- **Post-sync HEAD contains merge:** да / нет

### Локальное adoption
- Выполнено: <нумерованный список конкретных действий и файлов>
- Требует оператора вручную: <если осталось — process/session recycle, секреты, отдельные терминалы>
- Не требовалось: <если No operator adoption>

### Runtime adoption (Step 8)
- **Runtime-sensitive:** да / нет
- **origin/main SHA:** <ORIGIN_MAIN>
- **merge SHA:** <MERGE_SHA>
- **Orchestrator session id:** <S>
- **Runtime worktree before:** <WT> @ <WT_BEFORE_HEAD> (<WT_BEFORE_BRANCH>)
- **ProjectConfig:** обновлён (`ao project set-config ...`) / не требовался / не удался (<stderr>)
- **Session/process recycle:** выполнен / не требовался / не удался (<команды>)
- **Runtime worktree after:** <WT> @ <WT_AFTER_HEAD> (<WT_AFTER_BRANCH>)
- **Journaled worker-send (8e):** skipped fail-closed on AO 0.10.2 / migrated proof run (<issue>) / not relevant
- **Runtime adoption:** подтверждён / prompt delivery pending #625 / stale / пропущен (не runtime-sensitive)
- **Escalation:** <recovery runbook step / change-orchestrator-runtime / contract gap / —>

### Worker handoff (Step 3b)
- **Delegated:** yes / no
- **Worker session:** <W / none>
- **CI green after handoff:** yes / still blocked / not needed

### Worker session (Step 9)
- **Worker session id:** <W / not found / multiple — stopped>
- **Kill:** выполнен / пропущен (нет сессии) / не удался (<stderr>)
- **Cleanup:** `ao session cleanup -p orchestrator-pack -y` — <краткий итог stdout>
- **Post-check:** нет worker с prNumber/issueId=P / остался <id> (<статус>)

### Проверка
- `git status --short`: …
- `git log -1 --oneline`: …
```

Do not claim CI/adoption/session recycle succeeded without the commands you actually ran.

---

## Do not

- Delegate merge or adoption to `opencode run` / `opencode-publish.sh`
- Merge without identifying the PR
- Fix red CI or rebase/sync the PR branch in the architect session when an AO
  worker for that issue/PR is available — use Step 3b instead (unless the user
  explicitly authorized `direct-fix-checklist`)
- Merge or run local adoption while Step 3b worker handoff is still in progress
- Skip the adoption scan because CI is green
- Use `git push --force` to main
- Replace the user’s entire live yaml from example
- Drop a stash after a failed `stash pop`
- “Fix” a failed pull by discarding local changes
- Run AO lifecycle/session recycle commands from an AO-managed worker session
- `ao session kill` on the orchestrator session (`role: orchestrator`) outside Step 8
  runtime adoption / recovery runbook; Step 9 may kill only the merged PR's worker
  (`role: worker` / `coding`)
- Skip Step 9 worker teardown after a successful merge (kill + cleanup are mandatory)
- Destructive git (`reset`, `checkout`, `switch`, `clean`) or hand-edits inside the AO
  orchestrator worktree — **except** Step 6e sanctioned fast-forward when clean and behind
- Delete AO worktrees manually or claim session recycle succeeded without post-recycle HEAD check
- Require journaled worker-send adoption proof on AO 0.10.2 before the send-transport
  migration lands; record Step 8e as fail-closed instead
