# AO Codex PR Reviewer

Contract and implementation notes for Codex reviewer integration with AO.

## Goal

Run PR-level review with Codex CLI while AO planning and coding stay on Cursor CLI.

## Boundaries

- Source of truth for tasks: GitHub Issues.
- Source of truth for merge readiness: GitHub PR review state + CI.
- Planner/orchestrator: Cursor CLI via AO `orchestrator.agent: cursor`.
- Coder/worker: Cursor CLI via AO `worker.agent: cursor`.
- Reviewer: Codex CLI, via AO's built-in review mechanism (primary) or GitHub
  Actions workflow (alternative for CI-based review).

## How review works

### Primary path — AO built-in local review (WORKING)

AO has a built-in Codex review mechanism. When a PR is created by an AO worker
session, AO automatically calls Codex CLI **locally** on the developer's machine
using `codex exec review`. Results appear in the AO dashboard under "Reviews".

Review lifecycle:
1. Worker session opens a PR.
2. AO detects the PR and triggers review automatically (or via the Review button).
3. AO calls `codex exec review` with the PR files on the local machine.
4. Findings are shown in the AO dashboard Reviews board.

Prerequisites for this path:
- Codex CLI installed (`npm install -g @openai/codex`)
- Codex authenticated (`codex login`)
- AO 0.9.2 Windows patch applied (see below)

#### Windows fix for AO 0.9.2

AO 0.9.2 has two upstream bugs on Windows that break the built-in review:
1. Wrong subcommand: calls `codex exec --sandbox read-only` instead of `codex exec review`
2. `shell: true` causes Windows to split multi-word arguments incorrectly

Apply the patch before running AO:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/patch-codex-review4.ps1
```

The script patches the bundled Next.js chunk in:
```
%APPDATA%\npm\node_modules\@aoagents\ao\node_modules\@aoagents\ao-web\.next\server\chunks\4148.js
```

Re-run after every `npm install -g @aoagents/ao` upgrade.

### Alternative path — GitHub Actions CI review

A reusable workflow is provided at:

```
.github/workflows/codex-pr-review.yml
```

This runs Codex in GitHub Actions CI (not locally) and can post findings as
GitHub PR comments. Authentication uses ChatGPT OAuth credentials stored as the
`CODEX_AUTH_JSON` repository secret. Caller and reusable workflows need
`issues: read` so `gh issue view` can load linked-issue denylist/allowed_roots fences.

The reusable workflow checks out **two** repositories: the caller PR head (workspace
root, where `codex exec review` runs) and `orchestrator-pack` at
`orchestrator-pack/` (wrapper + `npm ci`). The pack ref is resolved from
required `pack_ref` input set to the same ref as the caller's `uses: ...@pin`
(e.g. `main`, a tag, or branch). `job.workflow_sha` / `job.workflow_ref` are not
populated for the called reusable workflow pin — do not rely on them or on
`github.workflow_ref` (that is the caller workflow). The reviewer runs via
`./node_modules/.bin/tsx` inside the pack checkout so caller repos do not need
`tsx` installed.

For untrusted PR workspaces (`codex-github-action` / `PR_REPO_ROOT`), Codex runs
with `--sandbox read-only` (no sandbox bypass) and the child process env omits
`GH_TOKEN` and related CI secrets so prompt injection cannot exfiltrate them.

Use this path if you want review results visible on the GitHub PR rather than
only in the local AO dashboard.

**One-time secret setup (PowerShell, local machine):**

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("$env:USERPROFILE\.codex\auth.json")
) | clip
# Paste the clipboard value as the CODEX_AUTH_JSON secret in the target repo.
```

Caller workflow for a target repository: copy
`docs/templates/codex-pr-review-caller.yml` into `.github/workflows/pr-review.yml`
(see `docs/target_repo_setup.md` section 6).

### Scoped reviewer wrapper (local AO primary path)

Use the pack-owned wrapper so Codex receives declaration scope and returns
structured findings (or the `NO_FINDINGS` clean-review token):

```powershell
# From the repository root (reviewer workspace or target repo checkout)
ao review run <worker-session-id> --execute --command `
  "node --import tsx plugins/ao-codex-pr-reviewer/bin/review.ts --repo-root . --base origin/main"
```

On Windows, prefer the PowerShell launcher:

```powershell
ao review run <worker-session-id> --execute --command `
  "pwsh -NoProfile -File plugins/ao-codex-pr-reviewer/bin/review.ps1 --repo-root . --base origin/main"
```

Wrapper contract:

| Codex stdout (trimmed) | Wrapper exit | AO / worker effect |
|------------------------|--------------|-------------------|
| Exactly `NO_FINDINGS` | 0, empty stdout | `findingCount: 0`, run `clean` |
| Empty | non-zero | Run `failed`; log: `reviewer produced empty output` |
| Legacy prose (“No concrete bugs…”) | non-zero | Run `failed`; no warning-finding noise |
| JSON `{"findings":[…]}` | 0 | Structured findings parsed into AO store |

The wrapper always loads the pack-bundled `prompts/codex_review_prompt.md` (never
a copy in the reviewed workspace), injects scope from the linked
issue (`denylist`, `allowed_roots`) and the active declaration snapshot
(`docs/declarations/{issue}.{iteration}.json` via `_shared` / scope-guard loaders),
and maps findings to architecture §F (`type`, `code`, `severity`, `path`,
`summary`, `source`, signature).

Resolve the issue number from `AO_ISSUE_NUMBER`, `--issue`, or the PR body
(`Closes #N`). When neither issue fences nor a snapshot exist, the prompt omits
authoritative scope and the wrapper adds a non-blocking
`scope-context-unavailable` warning finding.

### Dual-path shared contract

Both the local AO path and the optional GitHub Actions workflow use:

- `prompts/codex_review_prompt.md` — single prompt contract
- `plugins/ao-codex-pr-reviewer/bin/review.{ts,ps1}` — scope assembly, Codex
  invocation (`codex exec review`), `NO_FINDINGS` filtering, structured output
- Architecture §F finding format and signatures (`plugins/ao-token-chain-ledger`)

The reusable workflow calls the same wrapper; it posts
`## Codex Review — no findings` when Codex returns `NO_FINDINGS` instead of
dumping reviewer prose.

## Non-goals

- Do not add unsupported `reviewer:` keys to `agent-orchestrator.yaml`.
- Do not patch `packages/core/**` in any vendored AO checkout. This is a no core patch design.
- Do not store API keys, tokens, or model credentials in this repository.

## Contract markers

- Reviewer: Codex CLI (default model `gpt-5.5`)
- Trigger: PR review against GitHub Issues-linked PRs
- Constraint: no core patch — AO core is never modified by this plugin
