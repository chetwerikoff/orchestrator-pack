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

Local Codex PR review **is active**. AO drives it through the first-class
`ao review` CLI (`run`, `send`, `list`, `execute`). Orchestration and the
autonomous review loop live in `orchestratorRules` in `agent-orchestrator.yaml`
(see `agent-orchestrator.yaml.example`). Discover current runs with
`ao review list <project>` and the AO dashboard Reviews board.

Reviewer: Codex CLI with `gpt-5.5`, authenticated via **ChatGPT OAuth**
(`codex login`).

See also: [`README.md`](../README.md#local-codex-review-active),
[`prompts/agent_rules.md`](../prompts/agent_rules.md), and
[`docs/architecture.md`](architecture.md#review-paths).

On AO 0.9.x there is no `reviewer:` YAML role that AO reads — if you add
`reviewer:` to YAML, AO parses it without error or warning but silently ignores
it; wire review through `orchestratorRules` and `ao review`, not a `reviewer:`
key.

### Primary path — AO built-in local review

AO 0.9.2 includes a built-in Codex review pipeline. When a worker session creates
a PR, AO automatically calls `codex exec review` **on the local machine** and
shows results in the dashboard Reviews board.

On Windows with AO 0.9.2, this is broken upstream (wrong subcommand + Windows
shell argument splitting). Apply the patch once after installing AO:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/patch-codex-review4.ps1
```

Re-run this after every `npm install -g @aoagents/ao` upgrade.

Prerequisites: Codex CLI installed and authenticated (`codex login`).

### Alternative path — GitHub Actions CI review

A reusable workflow at `.github/workflows/codex-pr-review.yml` runs Codex in CI
and can post review findings as GitHub PR comments. Useful when you want review
output visible on the GitHub PR rather than only in the local AO dashboard.

See `plugins/ao-codex-pr-reviewer/README.md` for the full wiring and secret setup.

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
