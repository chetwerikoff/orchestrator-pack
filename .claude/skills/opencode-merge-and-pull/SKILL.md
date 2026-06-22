---
name: opencode-merge-and-pull
description: >-
  Standalone OpenCode terminal workflow: merge a ready PR by issue/PR number and
  pull main in the LIVE working tree, then apply documented local operator
  adoption. Use when the user says «мерж 307», «merge 307», «смерж #42», «merge
  and pull 307», or similar — number is issue or PR. NEVER discard uncommitted
  local work. Skip when only discussing merge policy with no number, or when
  inside an AO-managed session that should use merge-with-local-adoption instead.
compatibility: opencode
---

# OpenCode: merge, pull, local adoption (safe dirty tree)

Use this skill when **you are the OpenCode session in the operator's terminal**
and the user names a task number, e.g. «мерж 307», «merge 307».

Goal: merge the PR → update local `main` → apply post-merge local steps from the
issue/PR → report exactly what changed.

**This skill operates on the operator's live checkout.** It does **not** use an
isolated scratch checkout.

---

## Triggers

- «мерж 307», «смерж 307», «замержи 307», «мерж и пул 307»
- «merge 307», «merge and pull 307», «merge #307»
- Same phrases with `#` optional

**Skip** when there is no number, or the user only asks about merge policy.

**Skip delegation to this skill** from architect surfaces — they use
`merge-with-local-adoption` (different pull semantics).

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

### REQUIRED

1. Run the **pre-flight snapshot** (below) and keep its output for the final
   report.
2. After every git step, re-run `git status --short` and confirm no tracked file
   disappeared from the dirty list without an explicit, reported reason.
3. If a git command would fail because of local changes — **stop and report**;
   do not “fix” by discarding changes.
4. Prefer `git fetch` + explicit `git merge` over exotic pull flags.

---

## Step 1 — Pre-flight snapshot (mandatory)

Run and **save the output** (you will paste a summary in the final report):

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short
git diff --stat
git diff --cached --stat
git stash list
```

Record:

- Repo root path
- Current branch
- Every modified / staged / untracked path (count + names)
- Whether the tree is dirty

If `git status --short` is non-empty, note: **dirty tree — use safe pull only
(Step 6).**

---

## Step 2 — Resolve PR from the number

Let `N` be the user’s number (e.g. 307).

Resolve in order:

1. `gh pr view N --repo chetwerikoff/orchestrator-pack --json number,title,body,state,mergeable,headRefName,baseRefName,url`
   — if this works, `N` is the PR.
2. Else open PR for issue N:
   `gh pr list --repo chetwerikoff/orchestrator-pack --state open --search "N" --json number,title,body,headRefName`
   — prefer PR whose body contains `Closes #N` / `Fixes #N` / `Resolves #N`, or
   whose head branch matches the issue slug.
3. Else `gh issue view N --repo chetwerikoff/orchestrator-pack --json title,body,state`
   and search again for an open PR linked to that issue.

If zero or multiple PRs match, **ask once** — do not guess.

Record: PR number `P`, title, linked issue `I` (from PR body if present).

---

## Step 3 — Merge readiness

Unless the user explicitly waives checks:

```bash
gh pr checks P --repo chetwerikoff/orchestrator-pack
gh pr view P --repo chetwerikoff/orchestrator-pack --json mergeable,reviewDecision,state
```

Stop without merging if:

- `state` is not `OPEN`
- `mergeable` is not `MERGEABLE` (offer `gh pr update-branch P` first if behind)
- Required checks are failing

---

## Step 4 — Collect local adoption instructions

Read **all** of these before merging:

| Source | Command |
|--------|---------|
| PR body | `## Operator adoption` section |
| Linked issue `I` | `gh issue view I --json body` — Operator adoption / Binding surface |
| PR diff | `gh pr diff P --name-only` and relevant hunks |
| Migration notes | `docs/migration_notes.md` sections referenced in the PR |
| Draft (if thin issue) | row in `docs/issue_queue_index.md` → `docs/issues_drafts/…` |

**Operator-facing surfaces** (same list as `merge-with-local-adoption`):

- Live `agent-orchestrator.yaml` — **merge blocks**, never replace the whole file
- `orchestratorRules`, `reactions`, `notifiers`, `notificationRouting`
- Long-running scripts (wake listener, trust watcher, heartbeat)
- Documented env vars (`PACK_REVIEWER`, webhook URL, etc.)
- Runbooks under `docs/orchestrator-*-runbook.md`
- Steps requiring `ao stop` / `ao start` (operator-only — see Step 7)

If the PR says `No operator adoption required` and the diff has no operator
surfaces, skip Step 7 content but still say so in the report.

---

## Step 5 — Merge the PR

Do **not** run local `git merge` of the PR branch — use GitHub:

```bash
gh pr merge P --repo chetwerikoff/orchestrator-pack --merge --delete-branch
```

Use `--squash` or `--rebase` only if the user asked in the same message.

Verify:

```bash
gh pr view P --repo chetwerikoff/orchestrator-pack --json state,mergedAt,mergeCommit
```

If merge fails, stop and report stderr; do not retry with force.

---

## Step 6 — Safe pull in the live checkout

Default branch: `main` (confirm with
`git symbolic-ref --quiet refs/remotes/origin/HEAD` or project docs).

### 6a — Fetch only first

```bash
git fetch origin
```

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
# On current branch, merge mainline without switching:
git merge --no-edit origin/main
```

- If you **must** be on `main` for adoption edits and checkout is blocked:

```bash
STASH_MSG="opencode-merge-and-pull preserve $(date -u +%Y-%m-%dT%H:%M:%SZ)"
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

Compare to Step 1 snapshot:

- Every path that was modified/staged/untracked before must still exist or be
  accounted for (e.g. legitimately committed, or user asked to delete).
- If anything disappeared → **report as incident**; do not claim success.

**Never** use `git reset --hard origin/main` to “sync”.

---

## Step 7 — Apply local operator adoption

Execute only steps documented in Step 4. Rules:

1. **Surgical edits** — change only files and keys the adoption section names.
2. **`agent-orchestrator.yaml`** — copy/merge the listed YAML blocks from
   `agent-orchestrator.yaml.example` or the PR description; preserve all
   unrelated keys and comments.
3. **Do not commit** live yaml, secrets, or machine-local config unless the user
   explicitly asked to commit in the same message.
4. **`ao stop` / `ao start`**, listener scripts, `PACK_REVIEWER` changes: run
   only when the adoption section requires them; say clearly in the report that
   a restart was performed or is still required.
5. If adoption is ambiguous, apply the minimal safe change and list open
   questions in the report — do not guess destructive steps.

After edits:

```bash
git status --short
```

Confirm pre-existing dirty files are still present (content may have shifted if
the user edited the same files — but paths must not vanish).

---

## Step 8 — Final report (required)

Reply in the user’s language (Russian if they wrote Russian). Use this structure:

```markdown
## Merge и pull — отчёт

**PR:** #P — <title> (<url>)
**Issue:** #I (если есть)
**Merge commit:** <sha или mergedAt>

### Git
- Ветка до / после: …
- Pull: <что выполнено — checkout main + pull / merge origin/main / stash+pop>
- Dirty tree на старте: да/нет (<N> путей)

### Сохранность локальных файлов
- Пути из pre-flight, которые остались: …
- Stash: создан / не нужен / pop OK / pop с конфликтами (stash сохранён: …)
- **Запрещённые команды не использовались** (reset --hard, clean, restore ., stash drop)

### Локальное adoption
- Выполнено: <нумерованный список конкретных действий и файлов>
- Требует оператора вручную: <если осталось — restarts, секреты, отдельные терминалы>
- Не требовалось: <если No operator adoption>

### Проверка
- `git status --short`: …
- `git log -1 --oneline`: …
```

Do not claim CI/adoption/restart succeeded without the commands you actually ran.

---

## Do not

- Use `opencode-publish.sh` or a scratch checkout for this workflow
- Delegate to a nested `opencode run`
- Merge without resolving PR `P`
- “Fix” a failed pull by discarding local changes
- Drop a stash after a failed `stash pop`
- Replace the user’s entire live yaml from example
