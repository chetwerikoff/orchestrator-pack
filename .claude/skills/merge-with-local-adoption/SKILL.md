---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely pull main in the live checkout, and apply documented
  local operator adoption; verify the AO orchestrator runtime worktree contains
  the merge commit (Step 6e), recycle affected sessions for runtime-sensitive
  merges (Step 8), then kill the merged PR's worker session and run ao session
  cleanup. Use when the user asks to merge a finished task — «мерж», «мерж 385»,
  «мерж и пул», «смерж», «merge», «merge and pull» — or clearly wants a ready
  PR merged after review/CI. If CI is red or the branch is behind base, delegate
  the fix to the PR worker (Step 3b) and merge only after CI is green. Operates
  on the operator's live working tree; never discards uncommitted local work.
  Skip when the user only discusses merge policy without a concrete PR.
---

# Merge with local adoption

Run end-to-end from the **operator terminal** on the **live checkout**. Never delegate
merge/pull to `opencode run` / `opencode-publish.sh` / nested agents. OpenCode terminal
sessions use `../opencode-merge-and-pull/SKILL.md` instead. AO lifecycle commands and
worktree probes run from the operator terminal only — never inside AO-managed sessions.

`N` in the trigger («мерж 385») is an issue **or** PR number — resolve in Step 2.

## AO 0.10.2 facts (steps rely on these; stated once)

- `agent-orchestrator.yaml` / `.example` are **not** live runtime config (legacy-import
  only). Live config = per-project ProjectConfig: `ao project get/set-config`; it resolves
  when a session spawns/restores — not on daemon restart. `ao start` has no project operand.
- PR review is run by the **pack-owned runner**, not by AO. Manual invocation is `node --experimental-strip-types scripts/pack-review-runner.ts start --session-id <worker-session-id>`; operational status comes from `scripts/pack-review-runner.ts list` or the compatible `Get-AoReviewRuns` pack-store view. GitHub PR review is the authoritative verdict; the pack-side run/status store is operational state only. Never use daemon review HTTP or `ao review submit` as a fallback or dual-write path.
- Send shape: `ao send --session <id> --message "<text>"` (what
  `scripts/journaled-worker-send.ps1` calls).
- `ao status --json` = daemon health only; never parse it for sessions.
- `ao session restore` does **not** fast-forward the session worktree to `main`.
- Worker-normative rules = `AGENTS.md` + `.cursor/rules/*.mdc`, injected verbatim into
  `cursor-agent -p` workers.
- Orchestrator runtime worktree is a separate clone that never auto-syncs:
  `~/.ao/data/worktrees/orchestrator-pack/orchestrator/orchestrator-orchestrator/`
  (often **not** `$WT_BASE/<session-id>/`).
- `jq` is not installed on this machine — parse JSON with `node -e`.

## Rule zero — never destroy local work

**FORBIDDEN:** `git reset --hard`; `git clean`; `git checkout -- .` / `git restore`
(anything discarding work); `git switch -f` / `checkout -f`; `git stash drop/clear`;
`git pull --rebase` on a dirty tree; autostash without a same-run pop + report; replacing
live `agent-orchestrator.yaml` from `.example`; deleting/overwriting files the user had
modified or untracked; **any** git mutation or hand-edit inside the AO orchestrator
worktree except the Step 6e sanctioned fast-forward; manual deletion of AO worktrees.

**REQUIRED:** keep the Step 1 snapshot for the report; re-run `git status --short` after
every git step (no tracked file may vanish unexplained); if a git command refuses because
of local changes — **stop and report**, never "fix" by discarding; prefer `git fetch` +
explicit merge over exotic pull flags.

## Step 1 — Pre-flight snapshot (mandatory)

Save the output of:

```bash
git rev-parse --show-toplevel; git branch --show-current
git status --short; git diff --stat; git diff --cached --stat; git stash list
```

If `git status --short` is non-empty: **dirty tree — safe pull only (Step 6c)**.

## Step 2 — Resolve the PR

With user number `N`, in order: (1) `gh pr view N --repo chetwerikoff/orchestrator-pack
--json number,title,body,state,mergeable,headRefName,url` — if valid, `P=N`;
(2) open PR for issue `N`: `gh pr list --state open --search "N" --json
number,title,body,headRefName`, prefer body containing `Closes/Fixes/Resolves #N`;
(3) no number: PR for current branch (`gh pr view`), or the URL/branch the user named.
Zero or multiple matches → **ask once**, don't guess.
Record PR `P`, title, linked issue `I` from the PR body.

## Step 3 — Confirm merge readiness

Unless the user explicitly waives checks:

```bash
gh pr checks P --repo chetwerikoff/orchestrator-pack
gh pr view P --json mergeable,reviewDecision,state,mergeStateStatus,statusCheckRollup
```

Stop without merging if state ≠ `OPEN`, not `MERGEABLE`, required checks failing, or
review blocking.

## Step 3b — Worker handoff when CI red / branch behind

If checks fail or `mergeStateStatus` is `BEHIND`: **stop before Step 4**. Do not patch
worker-scope implementation from the architect session — delegate to the PR worker.

1. **Resolve worker:** `ao session ls --json -p orchestrator-pack`; find `role`
   `worker`/`coding` with `issue == I` (or branch matches PR head). No worker → report
   blocker (offer `ao spawn` only if the user asks). Architect direct fix only when the
   user explicitly authorized `direct-fix-checklist`.
2. **Send fix task** (collect evidence first: `gh pr checks P`, `gh run view <id>
   --log-failed`): `ao send --session <W> --message "<task>"` — include PR `P`, branch,
   issue `I`, failing checks + top log lines, sync-with-main requirement if behind, and
   an explicit **do not merge** (architect resumes at Step 3).
3. **Wait, then resume at Step 3** when checks are green and the branch is not behind
   (run `gh pr update-branch P` from the operator session if needed). Merge and adoption
   always run **after** CI is green — never in parallel with an in-flight worker fix.

## Step 4 — Collect adoption instructions; classify runtime-sensitive

Before merging, read: PR body (`## Operator adoption`), `gh pr diff P --name-only` (+
content for `.example`/runbooks/env docs), linked issue `I` body, the draft under
`docs/issues_drafts/` (via `docs/issue_queue_index.md`) if the body is thin, and
`migration_notes.md` hunks in the diff.

**Adoption-likely surfaces** (any change ⇒ check for local operator work even when not
runtime-sensitive): `.example` / env docs; machine-local CLI config
(`~/.cursor/cli-config.json`); runbook/go-live docs (`orchestrator-autoloop-go-live.md`,
`orchestrator-wake-runbook.md`, `orchestrator-recovery-runbook.md`,
`reviewer-switch-runbook.md`); anything requiring a long-running process or AO session
respawn. Do not report «адаптации нет» without scanning these.

**Runtime-sensitive: yes** when the diff/adoption touches any of:

- `AGENTS.md` or `.cursor/rules/*.mdc` (worker rules channel)
- `scripts/autonomous-*`
- orchestrator side processes (wake listener/supervisor, heartbeat, trust watcher,
  `wait-orchestrator-launch.ps1`)
- ProjectConfig wiring (`PACK_REVIEWER`, PATH prepend, `--env`, `--worker-agent`,
  `--orchestrator-agent`)
- long-running pack processes whose command/env must change
- adoption text explicitly requires a session respawn / process restart

**Not runtime-sensitive by itself:** anything YAML-legacy (`agent-orchestrator.yaml`,
`.example`, `orchestratorRules`, `reactions`, `notifiers`, `notificationRouting`) — see
facts. **No** (skip Step 8) only when the diff is docs/tests/`plugins/**` only, no
process/ProjectConfig/prompt-channel surface changed, and the PR says no operator
adoption. When unsure → treat as runtime-sensitive.

Tell the user in one short block (their language) what local work follows the merge, or:
«Локальных настроек нет — мержу без post-merge шагов».

## Step 5 — Merge

```bash
gh pr merge P --repo chetwerikoff/orchestrator-pack --merge --delete-branch
gh pr view P --json state,mergedAt,mergeCommit
```

`--squash`/`--rebase` only if the user asked. Record `MERGE_SHA` from `mergeCommit.oid`.
On failure: stop, report stderr, no force-retry. No local `git merge` of the PR branch.

## Step 6 — Safe pull in the live checkout

Run when the user asked for pull or adoption needs merged `main`. Skip only when the user
explicitly asked not to update the local tree **and** no adoption needs it.

- **6a:** `git fetch origin`; record `ORIGIN_MAIN="$(git rev-parse origin/main)"`.
- **6b (clean tree):** `git checkout main && git pull --no-rebase origin main`.
- **6c (dirty tree):** try `git checkout main 2>&1 || true`. If refused: stay on branch —
  `git branch -f main origin/main` (only if NOT on main) or `git merge --no-edit
  origin/main`. If you must be on `main`:

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

### Step 6e — Orchestrator worktree probe (mandatory after every merge)

The runtime worktree does not auto-sync on pull, and restore doesn't fast-forward it (see
facts) — probe even when Step 8 is skipped. **Skip only when** neither `ao orchestrator ls
--json` nor `ao session ls --json -p orchestrator-pack --all` has a non-terminated
orchestrator row for `orchestrator-pack`.

Resolve id and worktree (fail closed — never guess an id):

```bash
git fetch origin
ORIGIN_MAIN="$(git rev-parse origin/main)"
MERGE_SHA="<from Step 5 mergeCommit.oid>"

S="${AO_ORCHESTRATOR_SESSION_ID:-$(node -e '
  const ex=c=>JSON.parse(require("child_process").execSync(c,{encoding:"utf8"})).data||[];
  const o=ex("ao orchestrator ls --json").find(r=>r&&r.projectId==="orchestrator-pack"&&!r.isTerminated)
       ||ex("ao session ls --json -p orchestrator-pack --all").find(r=>r&&(r.role==="orchestrator"||r.kind==="orchestrator")&&!r.isTerminated);
  if(!o||!o.id){console.error("no non-terminated orchestrator row");process.exit(2)}
  console.log(o.id)')}"
# Empty S + stderr "no non-terminated orchestrator row" = the legitimate 6e skip case.
# Empty S for any other reason (an ao command failed) = STOP and report — do not skip.
# Step 8a always stops on empty S (fail closed).

WT_BASE="${AO_DATA:-$HOME/.ao/data}/worktrees/orchestrator-pack"
for c in "$WT_BASE/orchestrator/orchestrator-$S" \
         "$WT_BASE/orchestrator/orchestrator-orchestrator" \
         "$WT_BASE/orchestrator" "$WT_BASE/$S"; do
  [ -e "$c/.git" ] && WT="$c" && break
done
[ -n "${WT:-}" ] || WT="$(git worktree list --porcelain | node -e '
  const L=require("fs").readFileSync(0,"utf8").split(/\r?\n/);
  for(let i=0;i<L.length;i++){const m=L[i].match(/^worktree (.+)$/);if(!m)continue;
    const b=(L[i+2]||"").startsWith("branch refs/heads/")?L[i+2].slice(18):"";
    if(m[1].includes("/worktrees/orchestrator-pack/orchestrator/")||b==="ao/opk-orchestrator"||b.startsWith("orchestrator/")){console.log(m[1]);process.exit(0)}}
  process.exit(2)')" || { echo "6e: orchestrator worktree not found — stop, do not guess" >&2; }
```

Probe (both must exit 0):

```bash
WT_HEAD="$(git -C "$WT" rev-parse HEAD)"
git merge-base --is-ancestor "$MERGE_SHA" "$WT_HEAD";     # worktree has merge commit
git merge-base --is-ancestor "$MERGE_SHA" "$ORIGIN_MAIN"  # origin/main has it
```

**Stale worktree** (first check fails): require `git -C "$WT" status --porcelain` empty,
then the sanctioned fast-forward — `git -C "$WT" fetch origin main && git -C "$WT" pull
--no-rebase origin main` — and re-probe. **Dirty / pull fails / still stale:** no
`reset`/`checkout`/`clean` inside `$WT`; run `scripts/orchestrator-worktree-preflight.ps1`
only when spawn logs show `branch_collision`/`EPERM`; classify the merge runtime-sensitive
retroactively (run Step 8 after a successful sync); escalate
`docs/orchestrator-recovery-runbook.md` Step 2b → 3, then **re-run the 6e fast-forward**
(restore alone never syncs). Record `S`, `WT`, `WT_HEAD`, branch, and sync action for the
report.

## Step 7 — Apply local operator adoption

Execute only what Step 4 documented. Surgical edits only (named files/keys). Map live
env/PATH/agent changes to `ao project set-config` — do not edit live YAML for runtime
adoption (facts). Do not commit live yaml/secrets/machine-local config unless the user
asked in the same message. Defer session/process recycling to Step 8 when
runtime-sensitive. Don't invent secrets/ports — copy from PR/docs. Ambiguous adoption →
minimal safe change + open questions in the report. Then `git status --short` — pre-existing
dirty files must remain.

## Step 8 — Runtime adoption verification (runtime-sensitive only)

Canonical paths — do not invent parallel procedures: ProjectConfig/env → `ao project
set-config`; worktree behind main → Step 6e fast-forward; `branch_collision`/`EPERM` →
recovery runbook Step 2b + `orchestrator-worktree-preflight.ps1`; launch health →
`scripts/wait-orchestrator-launch.ps1`; runtime/prompt delivery semantics →
`../change-orchestrator-runtime/SKILL.md`; post-merge review-loop policy → recovery
runbook «After manual PR merge».

- **8a:** reuse `S`/`WT` from 6e (re-resolve after restore; fail closed). Prerequisite:
  `$WT` already contains `MERGE_SHA` (6e) — restore won't fix that.
- **8b — baseline (save output):** `ORIGIN_MAIN`, `MERGE_SHA`, `WT_BEFORE_HEAD="$(git -C
  "$WT" rev-parse HEAD)"`, `ao orchestrator ls --json`, `ao session get "$S" --json -p
  orchestrator-pack`.
- **8c — apply config, recycle:** only when Step 4 found a real ProjectConfig requirement:
  `ao project set-config orchestrator-pack --env KEY=VALUE --json` (also
  `--orchestrator-agent` / `--worker-agent`); don't clear unrelated config. Process-only
  change → restart that process per its runbook, no ProjectConfig mutation. Then recycle
  when the surface affects the orchestrator session/env/prompts:

  ```bash
  ao session kill "$S" -p orchestrator-pack
  ao session restore "$S" -p orchestrator-pack
  pwsh -NoProfile -File scripts/wait-orchestrator-launch.ps1 -OrchestratorSessionId "$S" -ProjectId orchestrator-pack
  ```

  Worker-only env changes: record that ProjectConfig applies to newly spawned/restored
  workers; don't kill active workers to prove it. If adoption needs a path
  set-config/restore can't cover → stop, report a contract gap or defer to
  `change-orchestrator-runtime`.
- **8d — re-probe:** re-resolve `S`/`WT`; record `WT_AFTER_HEAD`, `WT_AFTER_BRANCH`,
  `ao orchestrator ls --json`, `ao session get "$S" --json`.
- **8e — send-transport guards** (when the merge touches send/journaling/worker-nudge
  code):

  ```bash
  pwsh -NoProfile -File scripts/check-ao-send-transport-contract.ps1
  pwsh -NoProfile -File scripts/check-ao-send-transport-contract.ps1 -ValidateCommitted
  pwsh -NoProfile -File scripts/check-ao-dead-argv-bypass.ps1
  ```

- **8f — success criteria (all must hold to claim adoption confirmed):**
  1. `git merge-base --is-ancestor "$MERGE_SHA" "$WT_AFTER_HEAD"` exits 0 **and**
     `git merge-base --is-ancestor "$MERGE_SHA" "$ORIGIN_MAIN"` exits 0 — a pre-merge
     `WT_AFTER_HEAD` fails even if it's an ancestor of `ORIGIN_MAIN`.
  2. Orchestrator alive: non-terminated healthy row in `ao orchestrator ls --json`, or
     `wait-orchestrator-launch.ps1` exited 0.
  3. Spot-check one runtime-sensitive path in the worktree: `git -C "$WT" show
     HEAD:<path>` or `test -f "$WT/<path>"`.
  4. 8e guard results recorded when applicable (a guard failure is reported separately,
     it doesn't block unrelated surfaces).
  Never claim recycle/adoption succeeded without `WT_AFTER_HEAD` recorded.
- **8g — stale after recycle:** stop; record expected (`MERGE_SHA`/`ORIGIN_MAIN`) vs
  actual (`WT_AFTER_HEAD`); no destructive git anywhere. Recovery order: 6e fast-forward
  (if untried) → runbook Step 2b→3 (collision/EPERM only) → re-run 6e →
  `change-orchestrator-runtime` if worker-rules delivery is still stale. No safe path →
  note **contract gap**.

## Step 9 — Worker session teardown (mandatory)

From the operator terminal, after Step 7 (and Step 8 when it ran).

- **9a — resolve worker for PR `P`** from live AO state only (never infer from
  issue/branch/title):

  ```bash
  W="$(ao session ls --json -p orchestrator-pack --include-terminated | node -e '
    const d=JSON.parse(require("fs").readFileSync(0,"utf8")).data||[];const P=+process.argv[1];
    const ids=[...new Set(d.filter(r=>r&&(r.role==="worker"||r.role==="coding")&&!r.isTerminated
      &&(r.prNumber===P||r.issueId===String(P))).map(r=>r.id))];
    if(ids.length!==1){console.error("candidates: "+(ids.join(", ")||"none"));process.exit(2)}
    console.log(ids[0])' "$P")"
  ```

  Zero → record «worker not found», skip 9b, still run 9c. Multiple → **stop**, list, ask
  once. **Hard guard:** `W` must not be orchestrator-shaped (`ao session get "$W" --json`).
- **9b — kill:** `ao session kill "$W" -p orchestrator-pack`; verify it's gone
  (re-list, expect no non-terminated row with id `W`). Failure → record, continue to 9c,
  no kill loops.
- **9c — cleanup:** `ao session cleanup -p orchestrator-pack -y`; record stdout. Never
  kill the orchestrator manually — cleanup targets eligible workers/reviewers only.
- **9d — post-check:** `ao session ls --json -p orchestrator-pack` — no worker row with
  `prNumber == P`; orchestrator row remains.

## Step 10 — Final report (required, user's language)

```markdown
## Merge и локальная адаптация — отчёт
**PR:** #P — <title>  **Issue:** #I  **Merge commit:** <sha>
### Git
- Pull: <checkout+pull / merge origin/main / stash+pop / пропущен>; dirty на старте: да/нет
- Pre-flight пути сохранены: да / <исключения>; stash: <state>; запрещённые команды не использовались
### Orchestrator worktree (6e)
- session <S>; <WT> @ <WT_HEAD>; sync: <none / fast-forward / escalated>; HEAD contains merge: да/нет
### Adoption
- Выполнено: <список>  /  Не требовалось  /  Осталось оператору: <…>
### Runtime (Step 8 — если runtime-sensitive)
- ProjectConfig: <обновлён/не требовался>; recycle: <выполнен/нет>; WT after: <WT_AFTER_HEAD>
- 8e guards: <passed / failed <name> / n/a>; adoption: подтверждён / stale / пропущен
### Worker (3b/9)
- Handoff: <yes/no>; worker <W>: kill <ok/skip/fail>; cleanup: <итог>; post-check: <ok/остался id>
### Проверка
- `git status --short` / `git log -1 --oneline`: <…>
```

Never claim CI/adoption/recycle succeeded without the commands actually run.

## Do not

- Merge or run adoption while a Step 3b worker fix is in flight; skip the adoption scan
  because CI is green; skip Step 6e/9 after a successful merge.
- `git push --force` to main; fix red CI from the architect session when a PR worker
  exists (unless `direct-fix-checklist` authorized).
- `ao session kill` the orchestrator outside Step 8 / recovery runbook; Step 9 kills only
  the merged PR's worker.
- Skip 8e guards when the merge touches send/journaling/worker-nudge code.
