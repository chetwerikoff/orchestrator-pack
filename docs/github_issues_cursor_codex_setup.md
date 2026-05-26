# GitHub Issues + Cursor planner/worker + Codex reviewer setup

This pack is configured for GitHub Issues as the task source of truth and Cursor
CLI as the AO planning/coding agent.

## Supported directly by current AO schema

Current upstream AO config supports these role-specific overrides:

```yaml
defaults:
  runtime: process
  agent: cursor
  orchestrator:
    agent: cursor
  worker:
    agent: cursor
  workspace: worktree
  notifiers: [desktop]

projects:
  example:
    tracker:
      plugin: github
    scm:
      plugin: github
    orchestrator:
      agent: cursor
    worker:
      agent: cursor
```

Meaning:

- planner/orchestrator: Cursor CLI
- coder/worker: Cursor CLI
- task tracker: GitHub Issues
- PR/CI/review state: GitHub SCM
- workspace isolation: git worktrees
- Windows runtime: process/ConPTY

## Reviewer policy

Desired reviewer: Codex CLI with model `gpt-5.5`, authenticated via **ChatGPT OAuth**.

The current upstream AO schema exposes `orchestrator` and `worker` role overrides,
but not a stable first-class `reviewer:` YAML role. Do not add unsupported YAML
keys just to express reviewer routing; schema-valid config is more important for
upgrade safety.

The implemented path is a reusable GitHub Actions workflow:

```
.github/workflows/codex-pr-review.yml
```

Authentication in CI uses ChatGPT OAuth credentials stored as `CODEX_AUTH_JSON`
(base64-encoded `~/.codex/auth.json`). The workflow uses `codex review --base`
(Codex CLI's native review command) — no manual diff generation needed.

One-time secret setup on local machine:

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("$env:USERPROFILE\.codex\auth.json")
) | clip
# Paste the clipboard value as CODEX_AUTH_JSON in the target repo settings.
```

See `plugins/ao-codex-pr-reviewer/README.md` for the full wiring snippet.

Do not patch `packages/core/**` to add reviewer routing.

## GitHub Issue task convention

Every issue intended for AO should include:

- clear title;
- acceptance criteria;
- explicit path scope or denylist;
- test/verification command when known;
- any files that must not be touched.

Every PR created from an issue should link back to the issue:

```text
Closes #123
```

or:

```text
Fixes #123
```

## Local prerequisites

Verify tools:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1 -StrictPrereqs
```

Additional expected local CLIs for this profile:

```powershell
cursor --version
codex --version
ao --version
gh auth status
```

## Start AO

Do not start AO without an explicit target repository. After copying the example
config to a local ignored `agent-orchestrator.yaml` and replacing the project
block, start one target repo explicitly:

```powershell
ao start C:\Users\che\Documents\Projects\your-target-repo
```

or:

```powershell
ao start https://github.com/your-org/your-repo
```
