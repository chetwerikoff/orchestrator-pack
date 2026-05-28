# Target repository setup

End-to-end checklist for adopting `orchestrator-pack` in a repository that AO
will plan and code against. This documents the user-facing flow implemented by
issues #4–#6: issue-body constraints, `ao-declare` snapshots, runtime scope
guard, and PR-level CI.

## Before you start

Copy or vendor the pack layout into your target repository so these paths exist
at the repo root:

- `plugins/` (including `_shared`, `ao-task-declaration`, `ao-scope-guard`)
- `scripts/` (including `install-git-hooks.ps1`, `pr-scope-check.ps1`)
- `prompts/`
- `.github/workflows/scope-guard.yml`
- `agent-orchestrator.yaml.example`
- root `package.json` with npm workspaces for `plugins/*`

The pack itself lives at [chetwerikoff/orchestrator-pack](https://github.com/chetwerikoff/orchestrator-pack).
Treat upstream AO as an npm install only — never clone or patch AO core.

Scope model (issue body vs declaration snapshot vs runtime mirror) is defined in
architecture decision **#3.A** (`docs/issues_drafts/00-architecture-decisions.md`):

- **Issue body** — authoritative task constraints (`denylist`, optional
  `allowed-roots`).
- **Committed snapshot** — `docs/declarations/{issue_number}.{iteration_id}.json`
  produced by `ao-declare`.
- **Runtime mirror** — gitignored `.ao/declarations/` for local guards only.

---

## Checklist

Work through these steps in order.

### 1. Prerequisites

Install and verify:

- **Node.js 20+**
- **Git 2.25+**
- **GitHub CLI (`gh`)** authenticated for the target repository

```powershell
node --version
git --version
gh auth status
```

Optional: run the pack verifier from the repo root:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1 -StrictPrereqs
```

### 2. Install AO CLI

Install upstream AO from npm (upgrade-safe; do not vendor AO core):

```powershell
npm install -g @aoagents/ao
ao --version
```

On Windows with AO 0.9.2, apply the Codex review compatibility patch once after
install (see `README.md`). Re-run after every global AO upgrade.

### 3. Copy local AO config

Create a local-only config from the example (never commit this file):

```powershell
Copy-Item agent-orchestrator.yaml.example agent-orchestrator.yaml
notepad agent-orchestrator.yaml
```

Edit the `projects:` block for your repository: set `repo`, `path`, and
`defaultBranch`. Keep:

```yaml
agentRulesFile: prompts/agent_rules.md
```

Do not add unsupported YAML fields (for example a top-level `reviewer:` role).
Codex review is wired through AO's built-in path or the GitHub Actions workflow
in step 6.

### 4. Generate and set `CODEX_AUTH_JSON`

Only required when you use the GitHub Actions Codex review path (step 6).

On your local machine, authenticate Codex CLI (`codex login`), then base64-encode
the OAuth credential file:

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("$env:USERPROFILE\.codex\auth.json")
) | clip
```

In the **target repository** on GitHub: **Settings → Secrets and variables →
Actions → New repository secret**. Name it `CODEX_AUTH_JSON` and paste the
clipboard value.

See `plugins/ao-codex-pr-reviewer/README.md` for details.

### 5. Install scope-guard pre-commit hook and agent wrapper

From the target repository root, install npm dependencies and the managed
pre-commit hook:

```powershell
npm ci --include=dev
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install-git-hooks.ps1 -InstallScopeGuard
```

The hook calls `plugins/ao-scope-guard/bin/scope-check.ts` on staged paths.
Set `AO_ISSUE_NUMBER` to the active GitHub Issue number before committing.

Wrap agent invocations so the working tree is checked after each turn (layer 1
guard):

```powershell
$env:AO_ISSUE_NUMBER = '<issue-number>'
node --import tsx plugins/ao-scope-guard/bin/agent-wrap.ts `
  --issue <issue-number> `
  -- cursor agent ...
```

See `plugins/ao-scope-guard/README.md` for bypass, direct `scope-check`, and
uninstall options.

### 6. Add Codex PR review workflow

Create `.github/workflows/pr-review.yml` in the target repository by copying
`docs/templates/codex-pr-review-caller.yml` (caller permissions include
`issues: read` so linked-issue scope fences resolve in CI). Set `pack_ref` to
the same ref as the `uses: ...@ref` pin (e.g. both `main` or both `v1.0.0`).

Ensure `.github/workflows/scope-guard.yml` from the pack is present (copied in
the preamble). It runs PR diff validation against the linked issue and committed
declaration snapshot.

### 7. Open a first GitHub Issue

Create an issue in the target repository using
`docs/issue_template_example.md` as the body. That file is the complete,
parseable issue template — it includes:

- a mandatory ` ```denylist ` fenced block;
- an optional ` ```allowed-roots ` fenced block;
- **no** `declared-files` / declared path lists in the issue body.

Example:

```powershell
gh issue create --title "First AO scoped task" --body-file docs/issue_template_example.md
```

Note the issue number (`<n>`) for the next steps.

### 8. Run `ao-declare`

With a clean worktree, produce the declaration snapshot from the issue constraints
and your planned paths:

```powershell
$env:AO_ISSUE_NUMBER = '<n>'
npx ao-declare --issue <n> `
  --declared-paths src/example.ts `
  --declared-globs src/**/*
```

Under AO, `iteration_id` comes from `AO_SESSION_ID`. Locally, the CLI generates
a wrapper id when the session variable is unset.

The command writes:

- committed artifact: `docs/declarations/<n>.<iteration_id>.json`
- runtime mirror: `.ao/declarations/<n>.<iteration_id>.json` (gitignored)

### 9. Commit the declaration snapshot

Stage and commit only the snapshot (and any in-scope work):

```powershell
git add docs/declarations/<n>.<iteration_id>.json
git commit -m "chore: add declaration snapshot for issue #<n>"
```

Do not commit `.ao/` mirror files or `agent-orchestrator.yaml`.

### 10. Smoke test — scope-guard blocks out-of-scope edits

Confirm the wrapper or pre-commit hook rejects paths outside the snapshot.

**Wrapper / worktree check** — modify a path not in the declaration, then run:

```powershell
$env:AO_ISSUE_NUMBER = '<n>'
# Edit a file outside declared scope, e.g. README.md, without amending the snapshot.
node --import tsx plugins/ao-scope-guard/bin/scope-check.ts `
  --issue <n> `
  --mode worktree
```

Expect exit code **1** and a JSON violation report on stderr.

**Pre-commit check** — stage an out-of-scope file and attempt a commit:

```powershell
$env:AO_ISSUE_NUMBER = '<n>'
git add README.md
git commit -m "should be blocked"
```

Expect the pre-commit hook to block the commit. To proceed after a legitimate
scope change, amend the declaration once per iteration (`ao-declare --amend`) or
start a new iteration — do not bypass except for documented emergencies
(`AO_SCOPE_GUARD_BYPASS`).

### 11. Push a PR and verify CI scope-guard

Open a feature branch, push, and open a PR that links the issue:

```powershell
git checkout -b feat/<n>-smoke-test
git push -u origin HEAD
gh pr create --title "Smoke test scope guard for #<n>" --body "Closes #<n>"
```

Confirm the **`scope-guard`** workflow passes for in-scope changes.

Then add an out-of-scope file to the same PR (for example `vendor/out-of-scope.txt`
or any path outside the snapshot and inside the issue denylist). Push again and
confirm the **`PR scope guard`** job fails. Remove the out-of-scope change before
merging.

---

## Related docs

- `docs/issue_template_example.md` — minimal parseable issue body
- `docs/github_issues_cursor_codex_setup.md` — Cursor planner/worker + Codex review
- `docs/repository_policy.md` — what not to commit
- `plugins/ao-task-declaration/README.md` — `ao-declare` contract
- `plugins/ao-scope-guard/README.md` — runtime guard and hook
- `plugins/ao-codex-pr-reviewer/README.md` — `CODEX_AUTH_JSON` and CI review
