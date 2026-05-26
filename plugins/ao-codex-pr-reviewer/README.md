# AO Codex PR Reviewer

Contract stub for an upgrade-safe Codex reviewer integration.

## Goal

Run PR-level review with Codex CLI using model `gpt-5.5` while AO planning and
coding stay on Cursor CLI.

This is a contract only. It must not patch AO core; it is a no core patch design.

## Boundaries

- Source of truth for tasks: GitHub Issues.
- Source of truth for merge readiness: GitHub PR review state + CI.
- Planner/orchestrator: Cursor CLI via AO `orchestrator.agent: cursor`.
- Coder/worker: Cursor CLI via AO `worker.agent: cursor`.
- Reviewer: Codex CLI, model `gpt-5.5`, via external plugin/workflow/session.

## Required behavior

A future implementation should:

1. Detect PRs created by AO sessions.
2. Read the linked GitHub Issue and declared scope.
3. Run Codex review with model `gpt-5.5` against the PR diff.
4. Report findings as GitHub PR review comments or a summarized PR comment.
5. Never auto-merge.
6. Never mutate source files during review.
7. Respect the same declared scope / denylist metadata as `ao-scope-guard`.
8. Avoid printing or committing secrets.

## Implementation paths

### GitHub Actions path — IMPLEMENTED

A reusable workflow is provided at:

```
.github/workflows/codex-pr-review.yml
```

Authentication: Codex CLI **ChatGPT OAuth** (`~/.codex/auth.json`). The file is
base64-encoded and stored as a repository secret `CODEX_AUTH_JSON`. The workflow
restores it before review and wipes it after. No API key required.

**One-time secret setup (PowerShell, local machine):**

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("$env:USERPROFILE\.codex\auth.json")
) | clip
# Paste the clipboard value as the CODEX_AUTH_JSON secret in the target repo.
```

Re-export when you see 401 errors in CI (OAuth token rotated). Re-run
`codex login` locally first, then repeat the export.

To wire the workflow into a target repository, add this file in the target repo:

```yaml
# .github/workflows/pr-review.yml  (in the target repository)
name: pr-review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  codex-review:
    uses: chetwerikoff/orchestrator-pack/.github/workflows/codex-pr-review.yml@main
    secrets:
      codex_auth_json: ${{ secrets.CODEX_AUTH_JSON }}
```

Optional inputs:

| Input | Default | Description |
|-------|---------|-------------|
| `model` | `gpt-5.5` | Codex model name |

### AO external plugin path

If upstream AO exposes a stable review/pipeline plugin API, implement this under
`plugins/ao-codex-pr-reviewer/` and register it through `agent-orchestrator.yaml`.

### Explicit session path

Until a stable reviewer role exists in AO config, a human can explicitly run a
Codex review session for a PR. This should be documented as an operational step,
not hidden in unsupported YAML fields.

## Non-goals

- Do not add unsupported `reviewer:` keys to `agent-orchestrator.yaml`.
- Do not patch `packages/core/**`.
- Do not make Vibe Kanban or Linear mandatory.
- Do not store API keys, tokens, or model credentials in this repository.
