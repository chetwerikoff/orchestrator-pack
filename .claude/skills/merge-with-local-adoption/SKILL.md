---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely pull main in the live checkout, and apply documented
  local operator adoption. For runtime-sensitive merges, verify the AO orchestrator
  runs on the current commit after operator restart. Use when the user asks to merge
  a finished task — e.g. «мерж», «мерж 385», «мерж и пул», «смерж», «merge»,
  «merge and pull» — or clearly wants a ready PR merged after review/CI. Operates
  on the operator's live working tree in Cursor; never discards uncommitted local
  work. Skip when the user only asks about merge policy without a concrete PR.
---

# Merge with local adoption (Cursor)

When the user asks to merge a **ready** task/PR, run this workflow end-to-end in
**Cursor** on the operator's **live checkout**. Do **not** delegate merge or adoption
to `opencode run`, `opencode-publish.sh`, or DeepSeek.

Goal: merge the PR → update local `main` when needed → apply post-merge local steps
from the issue/PR → for runtime-sensitive merges, restart AO from the **operator
terminal** and confirm the orchestrator runtime worktree is on the merged commit →
report exactly what changed.

**OpenCode terminal sessions** use
[`.claude/skills/opencode-merge-and-pull/SKILL.md`](../opencode-merge-and-pull/SKILL.md)
instead (same safety rules, different entrypoint).

**Managed-session guard:** run `ao stop` / `ao start` and worktree probes only from
the **operator terminal** (this Cursor skill). AO-managed worker sessions MUST NOT
run lifecycle or git commands inside AO worktrees (`prompts/agent_rules.md`).

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
  `git pull`, `git fetch`, `git reset`, `git checkout` / `git switch`, manual file
  edits to adopt merged content, or `git worktree remove`
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
`prompts/agent_rules.md`).

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

- `agent-orchestrator.yaml.example` — merge blocks into live `agent-orchestrator.yaml`
- `orchestratorRules`, `reactions`, `notifiers`, `notificationRouting`
- New/changed long-running scripts: `orchestrator-wake-listener.ps1`, trust watcher, heartbeat
- Documented env vars: `PACK_REVIEWER`, `AO_ORCHESTRATOR_SESSION_ID`, webhook URL/port
- Machine-local CLI config (`~/.cursor/cli-config.json`) called out in docs
- Runbook/go-live changes: `docs/orchestrator-autoloop-go-live.md`, `docs/orchestrator-wake-runbook.md`, `docs/orchestrator-recovery-runbook.md`, `docs/reviewer-switch-runbook.md`
- Anything requiring `ao stop` / `ao start` to reload

### Runtime-sensitive classification

Set **Runtime-sensitive: yes** when the PR diff (or adoption text) touches any of:

| Signal | Examples |
|--------|------------|
| Worker/orchestrator prompts | `prompts/**` |
| Autonomous bash surface | `scripts/autonomous-*` |
| Orchestrator side processes | wake listener, heartbeat, trust watcher, `orchestrator-wake-supervisor.ps1`, `wait-orchestrator-launch.ps1` |
| Live yaml template | `agent-orchestrator.yaml.example` |
| Runtime rules / wiring | `orchestratorRules`, `reactions`, `BASH_ENV`, `PATH` prepend, `agentConfig.env` |
| Explicit restart | adoption or `migration_notes.md` requires `ao stop` / `ao start` |

**Runtime-sensitive: no** (skip Step 8) when **all** of:

- Diff is docs / tests / `plugins/**` only, **and**
- No operator-process, `.example`, `prompts/**`, `scripts/autonomous-*`, or
  `orchestratorRules` / env-wiring changes, **and**
- PR body says `No operator adoption required` or equivalent, **and**
- Nothing in adoption text requires restart or live yaml merge

When unsure, treat as runtime-sensitive — under-adoption is worse than a restart.

Contract reference: Issue #101 (`docs/issues_drafts/35-operator-adoption-handoff-contract.md`).

### Brief pre-merge note (when adoption is needed)

Before merging, tell the user in one short block what local work you will apply
after pull (Russian or English matching the user). If no adoption: one line —

> Локальных настроек для этой задачи нет — мержу без post-merge шагов.

If runtime-sensitive, mention that Step 8 will restart AO and verify the orchestrator
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

## Step 7 — Apply local operator adoption

Execute only steps documented in Step 4. Rules:

1. **Surgical edits** — change only files and keys the adoption section names.
2. **`agent-orchestrator.yaml`** — copy/merge the listed YAML blocks from
   `agent-orchestrator.yaml.example` or the PR description; preserve all
   unrelated keys and comments. Say **merge, do not replace** for live yaml.
3. **Do not commit** live yaml, secrets, or machine-local config unless the user
   explicitly asked to commit in the same message.
4. **`ao stop` / `ao start`**, listener scripts, `PACK_REVIEWER` changes: defer
   lifecycle restarts to Step 8 when the merge is runtime-sensitive; otherwise run
   only when the adoption section requires them outside Step 8.
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

Canonical references — do **not** invent parallel worktree/git procedures:

| Need | Canonical doc / script |
|------|------------------------|
| Normal post-merge daemon restart | `docs/migration_notes.md` (operator adoption sections); `docs/orchestrator-recovery-runbook.md` — **Step 4 — Full `ao stop` / `ao start`** |
| Stale `orchestrator/*` branch / worktree before restart | `docs/orchestrator-recovery-runbook.md` — **Step 2b — Orchestrator worktree hygiene**; `scripts/orchestrator-worktree-preflight.ps1` |
| Launch health after orchestrator respawn | `scripts/wait-orchestrator-launch.ps1` (recovery runbook Step 3) |
| Fresh spawn when session metadata keeps stale prompts/rules | [`.claude/skills/change-orchestrator-runtime/SKILL.md`](../change-orchestrator-runtime/SKILL.md) — **APPLY PROCEDURE** (operator terminal only) |
| Merged PR review-loop policy (not worktree repair) | `docs/orchestrator-recovery-runbook.md` — **After manual PR merge** |
| Journaled worker-send adoption after AO restart | `docs/migration_notes.md` — **Journaled worker-send wrapper adoption (Issue #281)**; `docs/orchestrator-recovery-runbook.md` — worker message stuck / adoption; Step **8e** below |

**Journaled worker-send adoption (Step 8e):** run **only** after a factual AO
restart/reload in Step 8c (or `change-orchestrator-runtime` APPLY PROCEDURE). Skip when
Step 8 is skipped, when no restart occurred, or when the merge did not require runtime
reload and live worker-send routing was unchanged. Adoption binding is keyed to the
**AO epoch** and the **hash of the config path string** (resolved live
`agent-orchestrator.yaml` path) — not to a hash of YAML file contents.

### 8a — Resolve orchestrator session id and worktree path

Fail closed — resolve from env or live `ao status` only; **never** guess a default id.

```bash
P=orchestrator-pack
AO="$HOME/.agent-orchestrator/projects/$P"

resolve_orchestrator_session_id() {
  if [ -n "${AO_ORCHESTRATOR_SESSION_ID:-}" ]; then
    printf '%s\n' "${AO_ORCHESTRATOR_SESSION_ID}"
    return 0
  fi
  local status_json status_err
  status_err="$(mktemp)"
  if ! status_json="$(ao status --project orchestrator-pack --json 2>"$status_err")"; then
    echo "Step 8 aborted: ao status failed: $(cat "$status_err")" >&2
    rm -f "$status_err"
    return 1
  fi
  rm -f "$status_err"
  printf '%s' "$status_json" | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(input); } catch { process.exit(2); }
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const orch = rows.find((row) => row && row.role === "orchestrator");
  if (!orch || !orch.name) process.exit(2);
  process.stdout.write(String(orch.name));
});
' || {
    echo "Step 8 aborted: orchestrator session id not found in ao status .data[] (invalid JSON or no role=orchestrator row)" >&2
    return 1
  }
}

S="$(resolve_orchestrator_session_id)" || exit 1
WT="$AO/worktrees/$S"
```

Record `S` and `WT`. Re-run `resolve_orchestrator_session_id` in Step 8d when the id may
have changed after restart — still fail closed; do not substitute a guessed id.

### 8b — Pre-restart baseline (mandatory)

Run and **save output** before any restart:

```bash
git fetch origin
ORIGIN_MAIN="$(git rev-parse origin/main)"
MERGE_SHA="<from Step 5 mergeCommit.oid>"
WT_BEFORE_HEAD="$(git -C "$WT" rev-parse HEAD 2>/dev/null || echo MISSING)"
WT_BEFORE_BRANCH="$(git -C "$WT" branch --show-current 2>/dev/null || echo MISSING)"
ao status --project orchestrator-pack --reports full
```

### 8c — Operator restart (documented sequence)

Default post-merge reload (`docs/migration_notes.md`, recovery runbook Step 4):

```bash
env -u BASH_ENV ao stop orchestrator-pack
env -u BASH_ENV ao start orchestrator-pack
```

Use `env -u BASH_ENV` only when the autonomous bash interposer would block or
rewrite operator lifecycle commands; otherwise plain `ao stop` / `ao start` is fine.

If spawn logs show `workspace.branch_collision` or preflight reports stale items,
follow recovery runbook **Step 2b** first (read-only check, then `-Apply` only as
documented there — not ad-hoc `git worktree remove`):

```bash
pwsh -NoProfile -File scripts/orchestrator-worktree-preflight.ps1 -OrchestratorSessionId "$S"
# If findings and runbook says apply:
pwsh -NoProfile -File scripts/orchestrator-worktree-preflight.ps1 -OrchestratorSessionId "$S" -Apply
env -u BASH_ENV ao start orchestrator-pack
```

Optional post-start health wait (recovery runbook Step 3):

```bash
pwsh -NoProfile -File scripts/wait-orchestrator-launch.ps1 -OrchestratorSessionId "$S" -ProjectId orchestrator-pack
```

When adoption explicitly requires a **fresh orchestrator spawn** (model/runtime/rules
that restore will not regenerate — see `change-orchestrator-runtime` traps), run that
skill's **APPLY PROCEDURE** instead of only Step 4 above, then continue to 8d.

### 8d — Post-restart worktree re-probe

Re-run `resolve_orchestrator_session_id` (Step 8a) if the orchestrator id may have
changed after restart — **stop Step 8** on failure; then:

```bash
S="$(resolve_orchestrator_session_id)" || exit 1
WT="$AO/worktrees/$S"
WT_AFTER_HEAD="$(git -C "$WT" rev-parse HEAD 2>/dev/null || echo MISSING)"
WT_AFTER_BRANCH="$(git -C "$WT" branch --show-current 2>/dev/null || echo MISSING)"
ao status --project orchestrator-pack --reports full
```

### 8e — Journaled worker-send adoption (mandatory after AO restart in Step 8)

Run this block **after** Step 8c restart (and optional 8d worktree re-probe). Skip when
Step 8 was skipped or when no AO restart/reload occurred in this merge flow.

From the operator pack checkout (`orchestrator-pack` repo root):

```bash
cd /path/to/orchestrator-pack   # live checkout, not the AO orchestrator worktree

pwsh -NoProfile -Command '
. ./scripts/lib/Get-WorkerMessageAdoptionBinding.ps1
$b = Get-WorkerMessageAdoptionBinding -PackRoot (Get-Location).Path
& ./scripts/worker-message-send-adoption-preflight.ps1 `
  -AoEpoch $b.AoEpoch `
  -ConfigPath $b.ConfigPath `
  -WriteProbeEntries
exit $LASTEXITCODE
'
```

**Binding:** `Get-WorkerMessageAdoptionBinding` resolves the running AO epoch and the
loaded config path; preflight validates probe journal entries for that epoch plus the
**path-string hash** (not YAML content).

**Canonical preflight (`-WriteProbeEntries`):** invokes `ao send` into session
`synthetic-adoption-probe`. The live `orchestratorRules` routing rule must pipe through
`scripts/journaled-worker-send.ps1`. Success stdout includes
`[worker-message-send-adoption-preflight] effective routing adopted`.

**Outcome A — canonical preflight OK (adoption confirmed):**

- Command above exits 0.
- Stdout includes `[worker-message-send-adoption-preflight] effective routing adopted`.
- Live YAML routing through `ao send` → `journaled-worker-send.ps1` is **verified**.
- Record Step 9 journaled worker-send as **canonical preflight OK**.

**If canonical preflight fails with `Session 'synthetic-adoption-probe' does not exist` or
`probe_route_failed`:**

- **Do not** treat live YAML routing as verified.
- Tell the operator that session `synthetic-adoption-probe` must exist (or be created and
  kept) and canonical preflight must be re-run before **runtime adoption confirmed**.
- **Outcome B — wrapper/journal fallback only** (routing **not** confirmed): use only to
  validate wrapper/journal health and clear the adoption escalation when canonical routing
  proof is unavailable.
  `docs/migration_notes.md` Issue #281 and the recovery runbook describe canonical
  `-WriteProbeEntries` adoption only — they do **not** document this direct-wrapper path.

```bash
cd /path/to/orchestrator-pack

pwsh -NoProfile -Command '
$ErrorActionPreference = "Stop"
. ./scripts/lib/Get-WorkerMessageAdoptionBinding.ps1
. ./scripts/lib/Invoke-WorkerMessageSendAdoptionPreflight.ps1
. ./scripts/lib/Record-WorkerMessageDispatch.ps1
$root = (Get-Location).Path
$b = Get-WorkerMessageAdoptionBinding -PackRoot $root
$epoch = [string]$b.AoEpoch
$config = [string]$b.ConfigPath
$epochHash = ConvertTo-WorkerMessageSafeHashText $epoch
$configHash = ConvertTo-WorkerMessageSafeHashText $config
$runId = ConvertTo-WorkerMessageSafeHashText ([guid]::NewGuid().ToString("n"))
$journal = if ($env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL) {
  $env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL
} else {
  Join-Path ([IO.Path]::GetTempPath()) "orchestrator-worker-message-dispatch-journal.json"
}
$wrapper = Join-Path $root "scripts/journaled-worker-send.ps1"
foreach ($branch in @("plain-ao-send:pending-draft", "plain-ao-send:self-submitted")) {
  $payload = New-WorkerMessageAdoptionProbePayload -Branch $branch -EpochHash $epochHash -ConfigHash $configHash -RunIdHash $runId
  $env:AO_WORKER_MESSAGE_ADOPTION_PROBE = "1"
  $env:AO_WORKER_MESSAGE_ADOPTION_BRANCH = $branch
  $env:AO_WORKER_MESSAGE_ADOPTION_EPOCH = $epoch
  $env:AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH = $config
  $env:AO_WORKER_MESSAGE_ADOPTION_EPOCH_HASH = $epochHash
  $env:AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH_HASH = $configHash
  $env:AO_WORKER_MESSAGE_ADOPTION_RUN_ID_HASH = $runId
  $env:AO_WORKER_MESSAGE_DISPATCH_JOURNAL = $journal
  $payload | & $wrapper -SessionId synthetic-adoption-probe -AdoptionProbe `
    -JournalPath $journal -AoEpoch $epoch -ConfigPath $config `
    -AoEpochHash $epochHash -ConfigPathHash $configHash -AdoptionProbeRunIdHash $runId
  if ($LASTEXITCODE -ne 0) { throw "wrapper probe failed branch=$branch exit=$LASTEXITCODE" }
}
$r = Test-WorkerMessageSendAdoptionPreflight -JournalPath $journal -AoEpoch $epoch -ConfigPath $config -PersistState
if (-not $r.ok) { Write-Host $r.diagnosis; exit 46 }
Write-Host "[merge-8e-fallback] wrapper/journal probes validated; live YAML routing not verified"
exit 0
'
```

- Outcome B validates wrapper + journal for the current binding only.
- Even if journal validation prints `effective routing adopted`, **do not** equate that with
  Outcome A — no `-WriteProbeEntries` / no `ao send` routing proof.
- Record Step 9 journaled worker-send as **fallback wrapper only (routing не доказан)**.
- **Do not** report **runtime adoption confirmed** on Outcome B alone; list operator follow-up:
  create/keep `synthetic-adoption-probe`, rerun canonical preflight (command above).

**Post-8e checks** (health only — not adoption source of truth):

```bash
pwsh -NoProfile -File scripts/worker-message-submit-reconcile.ps1 -Once -DryRun
pwsh -NoProfile -File scripts/orchestrator-wake-supervisor.ps1 -Action Status
```

Do **not** claim adoption passed based on reconcile `-DryRun` alone — dry-run skips live
adoption-preflight side effects.

**Health expected after Outcome A or B:**

- `worker-message-submit-reconcile` shows **working** in supervisor Status.
- No `STATE FENCES UNTRUSTED` / `wrong_state_root_active_deliveries` on that child.

If health checks fail, stop and escalate via `docs/orchestrator-recovery-runbook.md`
worker-message section. Outcome B additionally leaves **runtime adoption unconfirmed** until
canonical preflight succeeds.

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
2. **Orchestrator alive:** `ao status --project orchestrator-pack` shows an
   orchestrator session with working/alive runtime (or
   `wait-orchestrator-launch.ps1` exited 0).
3. **Surfaces:** at least one runtime-sensitive path from Step 4 is present in the
   worktree at the expected content (spot-check: `git -C "$WT" show HEAD:<path>` or
   `test -f "$WT/<path>"` for a changed prompt/script named in the PR).
4. **Journaled worker-send (when Step 8c restart ran):**
   - **Outcome A (canonical `-WriteProbeEntries`):** required for **runtime adoption
     confirmed** — preflight `effective routing adopted`; `worker-message-submit-reconcile`
     **working**; no `STATE FENCES UNTRUSTED`.
   - **Outcome B (wrapper fallback only):** may satisfy health checks above, but **does
     not** satisfy this criterion — record **runtime adoption: routing не подтверждён**
     and operator follow-up to rerun canonical preflight.
   - If restart did not run, note **8e skipped (no restart)**.

Do **not** claim restart succeeded without recording `WT_AFTER_HEAD`.

### 8g — Stale worktree after restart — stop and escalate

If `WT_AFTER_HEAD` is `MISSING`, or either commit check in 8f fails (worktree does not
contain `MERGE_SHA`, or `origin/main` does not contain `MERGE_SHA`):

- **Do not** run destructive git inside `$WT` or the live checkout to “fix” it.
- **Stop** Step 8; record **expected** (`MERGE_SHA` / `ORIGIN_MAIN`) vs **actual**
  (`WT_AFTER_HEAD`).
- Direct the operator to the documented recovery path:
  1. `docs/orchestrator-recovery-runbook.md` — Step 2b → Step 3 or Step 4
  2. If prompts/rules remain stale after that: `change-orchestrator-runtime` APPLY PROCEDURE
- If no safe automated recreate path covers this scenario, note **contract gap** in the
  final report (do not improvise worktree deletion).

---

## Step 9 — Final report (required)

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

### Локальное adoption
- Выполнено: <нумерованный список конкретных действий и файлов>
- Требует оператора вручную: <если осталось — restarts, секреты, отдельные терминалы>
- Не требовалось: <если No operator adoption>

### Runtime adoption (Step 8)
- **Runtime-sensitive:** да / нет
- **origin/main SHA:** <ORIGIN_MAIN>
- **merge SHA:** <MERGE_SHA>
- **Orchestrator session id:** <S>
- **Runtime worktree before:** <WT> @ <WT_BEFORE_HEAD> (<WT_BEFORE_BRANCH>)
- **Restart:** выполнен / не требовался / не удался (<команды>)
- **Runtime worktree after:** <WT> @ <WT_AFTER_HEAD> (<WT_AFTER_BRANCH>)
- **Journaled worker-send (8e):** пропущен (без рестарта) / Outcome A canonical OK / Outcome B fallback only (routing не доказан) / failed (<причина>)
- **worker-message-submit-reconcile:** working / degraded (<причина>)
- **Runtime adoption:** подтверждён (только Outcome A) / routing не подтверждён (Outcome B) / stale / пропущен (не runtime-sensitive)
- **Escalation:** <recovery runbook step / change-orchestrator-runtime / contract gap / —>

### Проверка
- `git status --short`: …
- `git log -1 --oneline`: …
```

Do not claim CI/adoption/restart succeeded without the commands you actually ran.

---

## Do not

- Delegate merge or adoption to `opencode run` / `opencode-publish.sh`
- Merge without identifying the PR
- Skip the adoption scan because CI is green
- Use `git push --force` to main
- Replace the user’s entire live yaml from example
- Drop a stash after a failed `stash pop`
- “Fix” a failed pull by discarding local changes
- Run `ao stop` / `ao start` from an AO-managed worker session
- `git pull`, `reset`, `checkout`, or hand-edit inside the AO orchestrator worktree
- Delete AO worktrees manually or claim restart succeeded without post-start HEAD check
- Claim journaled worker-send adoption from `worker-message-submit-reconcile -DryRun` alone
  (dry-run skips adoption preflight; use `worker-message-send-adoption-preflight.ps1`)
- Treat direct wrapper probe fallback as proof that live YAML routing rule works
