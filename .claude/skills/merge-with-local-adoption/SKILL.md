---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely pull main in the live checkout, and apply documented
  local operator adoption. Use when the user asks to merge a finished task — e.g.
  «мерж», «мерж 385», «мерж и пул», «смерж», «merge», «merge and pull» — or clearly
  wants a ready PR merged after review/CI. Operates on the operator's live working
  tree in Cursor; never discards uncommitted local work. Skip when the user only
  asks about merge policy without a concrete PR.
---

# Merge with local adoption (Cursor)

When the user asks to merge a **ready** task/PR, run this workflow end-to-end in
**Cursor** on the operator's **live checkout**. Do **not** delegate merge or adoption
to `opencode run`, `opencode-publish.sh`, or DeepSeek.

Goal: merge the PR → update local `main` when needed → apply post-merge local steps
from the issue/PR → report exactly what changed.

**OpenCode terminal sessions** use
[`.claude/skills/opencode-merge-and-pull/SKILL.md`](../opencode-merge-and-pull/SKILL.md)
instead (same safety rules, different entrypoint).

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

## Step 4 — Collect local adoption instructions

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

**No local adoption** when:

- PR diff has none of the above **and** PR body contains exact line
  `No operator adoption required`, **or**
- Diff is docs/tests/plugins only with zero operator-process or `.example` wiring changes

Contract reference: Issue #101 (`docs/issues_drafts/35-operator-adoption-handoff-contract.md`).

### Brief pre-merge note (when adoption is needed)

Before merging, tell the user in one short block what local work you will apply
after pull (Russian or English matching the user). If no adoption: one line —

> Локальных настроек для этой задачи нет — мержу без post-merge шагов.

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

If merge fails, stop and report stderr; do not retry with force.

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
4. **`ao stop` / `ao start`**, listener scripts, `PACK_REVIEWER` changes: run
   only when the adoption section requires them; say clearly in the report that
   a restart was performed or is still required.
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

## Step 8 — Final report (required)

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
- **Запрещённые команды не использовались** (reset --hard, clean, restore ., stash drop, opencode delegation)

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

- Delegate merge or adoption to `opencode run` / `opencode-publish.sh`
- Merge without identifying the PR
- Skip the adoption scan because CI is green
- Use `git push --force` to main
- Replace the user’s entire live yaml from example
- Drop a stash after a failed `stash pop`
- “Fix” a failed pull by discarding local changes
