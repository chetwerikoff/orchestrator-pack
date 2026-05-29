# AGENTS.md

## Project Purpose

This repository is an upgrade-safe extension pack for ComposioHQ/agent-orchestrator.

It contains plugins, prompt fragments, config examples, scripts, and CI checks that port selected safety/accounting contracts from `ai-orchestrator` into Composio AO without modifying Composio core.

Draft specs map to GitHub Issues via [`docs/issue_queue_index.md`](docs/issue_queue_index.md)
(draft path ↔ `#N`; live state from `gh issue view`).

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
- `.claude/skills/**`
- `.cursor/skills/**`
- `CLAUDE.md`
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

## Auto-invoke: root cause investigation

When the user's message matches cause-investigation phrasing (best-effort discovery,
not a deterministic gate), follow [`prompts/investigate_root_cause.md`](prompts/investigate_root_cause.md)
immediately — no skill name required.

**Triggers (substring or clear paraphrase):** «разобраться с причиной», «в чём
причина», «что это», «разберись», «почему упал», «что сломалось», «отладь»,
«что случилось», «почему не работает»; «root cause», «why did», «figure out why»,
«investigate the cause», «wtf».

**Skip:** pure implementation; external adoption → `study-external-source`; one
tracked issue already fully answers the ask.

**Loader entry points (optional):** `.cursor/skills/investigate-root-cause/SKILL.md`,
`.claude/skills/investigate-root-cause/SKILL.md` — thin wrappers that defer to the
canonical file above.
