---
name: change-orchestrator-runtime
description: >-
  Change the orchestrator's model, prompt/rules, or runtime and make the change
  actually take effect. Use when the user wants to swap the orchestrator model
  (e.g. a different deepseek/openrouter model), edit orchestratorRules / the
  orchestrator prompt, or switch the orchestrator runtime
  (opencode/codex/cursor/ claude) — e.g. «поменяй модель оркестратора», «смени
  промпт оркестратора», «другой оркестратор», «change orchestrator model», «edit
  orchestrator rules», «switch orchestrator runtime». Editing
  agent-orchestrator.yaml + `ao start` is NOT enough — this skill covers the
  daemon-cache + session-restore traps and the verification that the new
  rules/model actually loaded.
---

Read and execute [`.claude/skills/change-orchestrator-runtime/SKILL.md`](../../../.claude/skills/change-orchestrator-runtime/SKILL.md) in full. Do not re-derive the workflow inline.
