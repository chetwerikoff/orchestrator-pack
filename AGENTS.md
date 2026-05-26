# AGENTS.md

## Project Purpose

This repository is an upgrade-safe extension pack for ComposioHQ/agent-orchestrator.

It contains plugins, prompt fragments, config examples, scripts, and CI checks that port selected safety/accounting contracts from `ai-orchestrator` into Composio AO without modifying Composio core.

## Hard Rule

Do not patch or vendor-modify `ComposioHQ/agent-orchestrator` core packages.

All custom behavior must live in one of:

- `plugins/`
- `prompts/`
- `scripts/`
- `.github/workflows/`
- config examples such as `agent-orchestrator.yaml.example`
- `docs/`

If upstream source is checked out under `vendor/`, treat it as read-only reference.

## What This Pack Ports

Prioritize portable contracts only:

- task declaration / denylist validation
- one-amendment declaration throttle
- scope-safe runtime git guard
- PR-level scope CI check
- self-architect prompt checks
- chain-level token/cost accounting

Do not port Windows PowerShell wrapper internals, `.ai-loop/` layout as a required protocol, or Composio UI replacements.

## Allowed Edits

- `plugins/**`
- `prompts/**`
- `scripts/**`
- `docs/**`
- `.github/workflows/**`
- `README.md`
- `AGENTS.md`
- `.gitignore`, `.gitattributes`, and reusable root-level tooling config
- config examples

## Do Not Edit

- `vendor/agent-orchestrator/**` unless explicitly asked to refresh upstream
- generated runtime state
- secrets or local credential files
- Composio AO `packages/core/**` in any vendored checkout

## Verification

Before finishing work, run:

```powershell
.\scripts\verify.ps1
.\scripts\check-reusable.ps1
```

If Git hooks are installed, `git push` should also run both checks through
`.\scripts\install-git-hooks.ps1`.

If a plugin has tests, run the plugin-specific test command documented in that plugin directory.

## Migration Principle

When adding behavior, prefer this order:

1. prompt/rules
2. config
3. plugin/hook
4. CI guard
5. documentation

Never choose a core patch unless the user explicitly asks for an upstream contribution plan.
