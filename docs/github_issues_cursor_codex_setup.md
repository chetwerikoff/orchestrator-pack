# GitHub Issues + Cursor planner/worker + pack-owned reviewer setup

This pack uses GitHub Issues as the task source of truth, Cursor CLI for planning
and coding, and the pack-owned runner for local PR review.

Canonical review operations: [`pack-review-runbook.md`](pack-review-runbook.md).

## AO project roles

Current AO project configuration supports role-specific agent overrides:

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

- planner/orchestrator: Cursor CLI;
- coder/worker: Cursor CLI;
- task tracker: GitHub Issues;
- PR/CI state: GitHub;
- worker isolation: git worktrees.

Worker policy is loaded from tracked `AGENTS.md`. On AO 0.10.2, live runtime
configuration is ProjectConfig rather than the example YAML file.

## Local reviewer policy

AO does not spawn the local pack reviewer. Manual and automatic starts enter:

```text
scripts/pack-review-runner.ts
```

The runner invokes trusted:

```text
scripts/invoke-pack-review.ps1
```

`PACK_REVIEWER` selects `codex` or `claude` behind that common entrypoint.

Manual start:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts start \
  --session-id <worker-session-id>
```

Status:

```bash
node --experimental-strip-types scripts/pack-review-runner.ts list \
  --project-id orchestrator-pack
```

The retired AO review commands, session-review HTTP, and the deleted pack shim are
legacy only. Do not use them as a fallback.

## Review authority

The live result is separated into distinct surfaces:

- reviewer computation: terminal JSON from the selected wrapper;
- durable result: pack review-run record with verdict and findings;
- presentation: GitHub COMMENT review;
- merge authority: exact-head required status `orchestrator-pack/pack-review`;
- worker continuation: independent worker-notification delivery outcome;
- operations: pack-store status, heartbeat, logs, and channel outcomes.

Repository branch protection must require `orchestrator-pack/pack-review` after the
journal-first delivery change is adopted.

## Reviewer prerequisites

For Codex:

```bash
codex --version
codex login
```

For Claude:

```bash
claude --version
```

For both:

```bash
node --version
git --version
gh auth status
pwsh --version
```

The old native-Windows AO patch is historical and not part of the supported
Ubuntu/WSL pack-owned path.

## Select Codex or Claude

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 \
  -Reviewer <codex|claude> \
  -RestartSupervisor
```

On supported Linux/WSL, `PACK_REVIEWER` is process-scoped and a running pack
side-process supervisor must be restarted to inherit the change. Windows
compatibility can resolve persistent User/Machine layers. Restarting the AO daemon
is not reviewer adoption.

## Optional GitHub Actions review

The reusable workflow `.github/workflows/codex-pr-review.yml` remains available for
external repositories that need CI-hosted review. It uses the same prompt, scope,
parser, and finding schema, but it is not the local invocation path.

## GitHub Issue task convention

Every issue intended for AO should include:

- a clear title and goal;
- testable acceptance criteria;
- explicit path scope, `allowed-roots`, or a denylist;
- verification commands when known;
- files or behavior that must not change.

Every PR must link its task issue near the top of the body:

```text
Closes #123
```

or:

```text
Fixes #123
```

## Local verification

```powershell
pwsh -NoProfile -File scripts/verify.ps1 -StrictPrereqs
```

Use the repository's normal verification suite for documentation and contract
changes; this setup does not define a separate review-documentation checker.

## Start AO

Start AO only for an explicit target repository. Live review remains pack-owned and
is started by the pack side-process fleet or the manual runner command above.

Do not patch `packages/core/**` to add reviewer routing.
