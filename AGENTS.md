# AGENTS.md

## Project Purpose

This repository is an upgrade-safe extension pack for ComposioHQ/agent-orchestrator.

It contains plugins, prompt fragments, config examples, scripts, and CI checks that port selected safety/accounting contracts from `ai-orchestrator` into Composio AO without modifying Composio core.

Draft specs map to GitHub Issues via [`docs/issue_queue_index.md`](docs/issue_queue_index.md)
(draft path ↔ `#N`; live state from `gh issue view`).

## Coworker CLI delegation (canonical policy)

Before shelling out to the external `coworker` CLI, read and follow the **Coworker CLI
delegation** section in [`prompts/agent_rules.md`](prompts/agent_rules.md) (single source of
truth: triggers, `--profile` usage, anti-delegation, reviewer carve-out, provider-input fence).
Do not duplicate that policy here. Architecture: §S in
[`docs/issues_drafts/00-architecture-decisions.md`](docs/issues_drafts/00-architecture-decisions.md).

## RTK read-exploration (canonical policy)

On RTK-enabled hosts, read and follow the **RTK read-exploration** section in
[`prompts/agent_rules.md`](prompts/agent_rules.md) (prefer dedicated file tools for reads;
RTK shell wrappers only when raw shell is genuinely needed). Do not duplicate that guidance
here. Inventory method: [`docs/rtk-missed-savings-inventory.md`](docs/rtk-missed-savings-inventory.md).
Architecture: §R.7 in
[`docs/issues_drafts/00-architecture-decisions.md`](docs/issues_drafts/00-architecture-decisions.md).

## Hard Rule

Do not patch or vendor-modify `ComposioHQ/agent-orchestrator` core packages.

All custom behavior must live in one of:

- `plugins/`
- `prompts/`
- `scripts/`
- `.github/workflows/`
- `.cursor/rules/` (always-applied Cursor project rules; thin pointers only)
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
- `.cursor/rules/**`
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

## RCA spec discipline (Issue #221)

Authoring and investigation invariants (`behavior-kind`, `positive-outcome`,
`parked-root-cause`, **recurrence-diagnostic**, **5-Whys stop condition**) are
defined in [`prompts/agent_rules.md`](prompts/agent_rules.md) and
[`prompts/investigate_root_cause.md`](prompts/investigate_root_cause.md). Cursor
rules mirror via [`.cursor/rules/rca-spec-discipline.mdc`](.cursor/rules/rca-spec-discipline.mdc).
When `prompts/agent_rules.md` changes, restart AO (`ao stop` / `ao start`).

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

## Auto-invoke: merge with local adoption

When the user asks to merge a ready task/PR (best-effort discovery, not a
deterministic gate), follow
[`.claude/skills/merge-with-local-adoption/SKILL.md`](.claude/skills/merge-with-local-adoption/SKILL.md)
immediately — no skill name required.

**Triggers (substring or clear paraphrase):** «мерж», «мерж и пул», «смерж»,
«смержи», «замержи»; «merge», «merge and pull», «merge the PR».

**Skip:** merge policy discussion without a concrete PR; user explicitly says not
to merge yet.

**Loader entry points (optional):** `.cursor/skills/merge-with-local-adoption/SKILL.md`,
`.claude/skills/merge-with-local-adoption/SKILL.md`.

## Auto-invoke: adversarial draft review

When the user asks to author a task draft/issue **and** involve Codex to
challenge the approach first (best-effort discovery, not a deterministic gate),
follow
[`.claude/skills/adversarial-draft-review/SKILL.md`](.claude/skills/adversarial-draft-review/SKILL.md)
immediately — no skill name required.

**Triggers (substring or clear paraphrase):** «с кодексом», «обсуди с кодексом»,
«посоветуйся с кодексом», «выясни с кодексом», «драфт с кодексом»,
«создай задачу с кодексом», «придирчиво», «оспорь подход»; «draft with codex»,
«adversarial draft», «challenge the approach».

**Skip:** plain «создай драфт» with no adversarial marker — use
`create-issue-draft` instead; «с gpt» — use `discuss-with-gpt`.

**Loader entry points (optional):** `.cursor/skills/adversarial-draft-review/SKILL.md`,
`.claude/skills/adversarial-draft-review/SKILL.md`.

## Auto-invoke: discuss with GPT

When the user asks to author a task draft/issue **and** involve GPT (the custom
ChatGPT project) to challenge the approach first (best-effort discovery, not a
deterministic gate), follow
[`.claude/skills/discuss-with-gpt/SKILL.md`](.claude/skills/discuss-with-gpt/SKILL.md)
immediately — no skill name required.

**Triggers (substring or clear paraphrase):** «с gpt», «с гпт», «обсуди с gpt»,
«обсуди с гпт», «посоветуйся с gpt», «выясни с gpt», «драфт с gpt»,
«создай задачу с gpt»; «draft with gpt», «discuss with gpt», «challenge with gpt».

**Skip:** plain «создай драфт» with no «с gpt» marker — use `create-issue-draft`
instead; «с кодексом» — use `adversarial-draft-review`.

**Loader entry points (optional):** `.cursor/skills/discuss-with-gpt/SKILL.md`,
`.claude/skills/discuss-with-gpt/SKILL.md`.

## Auto-invoke: create issue draft

When authoring or rewriting a task draft (`docs/issues_drafts/NN-<slug>.md`) or
syncing a new GitHub Issue spec, follow
[`.claude/skills/create-issue-draft/SKILL.md`](.claude/skills/create-issue-draft/SKILL.md)
immediately.

**Skip:** adversarial markers («с кодексом», «придирчиво», …) →
`adversarial-draft-review`; «с gpt» / «с гпт» → `discuss-with-gpt`.

**Loader entry points (optional):** `.cursor/skills/create-issue-draft/SKILL.md`,
`.claude/skills/create-issue-draft/SKILL.md`.

## Auto-invoke: study external source

When the user asks to study an external repo/URL for adoption, follow
[`.claude/skills/study-external-source/SKILL.md`](.claude/skills/study-external-source/SKILL.md).

**Loader entry points (optional):** `.cursor/skills/study-external-source/SKILL.md`,
`.claude/skills/study-external-source/SKILL.md`.

## Auto-invoke: publish issue draft

After [`create-issue-draft`](.claude/skills/create-issue-draft/SKILL.md) completes (Codex
draft review done, GitHub issue synced, registry updated), follow
[`.claude/skills/publish-issue-draft/SKILL.md`](.claude/skills/publish-issue-draft/SKILL.md)
to decide how the local draft is persisted. **Default is sync-only:** the GitHub
Issue is the queue; the draft file stays local and is NOT committed or PR'd.

**Also invoke (commit/PR/merge path)** when the user says: «опубликуй драфт»,
«закоммить драфт», «pr для драфта», «publish draft», «смержи драфт» (spec land,
not implementation) — then branch, commit, PR, merge to `main`, and reopen the
implementation issue if auto-closed.

**Skip:** user opts out of PR/merge; unrelated work on the branch.

## Auto-invoke: switch pack reviewer

When the user asks to switch local pack review between Codex and Claude, fix
`PACK_REVIEWER` drift (global User vs session Process), or verify which reviewer
will run, follow
[`.claude/skills/switch-pack-reviewer/SKILL.md`](.claude/skills/switch-pack-reviewer/SKILL.md)
immediately — no skill name required.

**Triggers (substring or clear paraphrase):** «переключи ревьюера», «поставь codex»,
«поставь claude», «PACK_REVIEWER», «switch reviewer», «reviewer codex/claude»,
«используется claude вместо codex», «глобально codex».

**Skip:** architecture-only discussion with no machine change; implementation
tasks that belong in a GitHub issue draft.

**Loader entry points (optional):** `.cursor/skills/switch-pack-reviewer/SKILL.md`,
`.claude/skills/switch-pack-reviewer/SKILL.md`.

## Auto-invoke: change orchestrator runtime

When the user wants to change the orchestrator's model, prompt/rules, or runtime
and make the change actually take effect (best-effort discovery, not a
deterministic gate), follow
[`.claude/skills/change-orchestrator-runtime/SKILL.md`](.claude/skills/change-orchestrator-runtime/SKILL.md)
immediately — no skill name required.

**Triggers (substring or clear paraphrase):** «поменяй модель оркестратора»,
«смени промпт оркестратора», «другой оркестратор»; «change orchestrator model»,
«edit orchestrator rules», «switch orchestrator runtime».

**Skip:** architecture-only discussion with no machine change; editing
`agent-orchestrator.yaml` without applying the daemon-cache and session-restore
steps this skill covers.

**Loader entry points (optional):** `.cursor/skills/change-orchestrator-runtime/SKILL.md`,
`.claude/skills/change-orchestrator-runtime/SKILL.md`.
