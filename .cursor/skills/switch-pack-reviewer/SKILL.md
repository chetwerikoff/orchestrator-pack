---
name: switch-pack-reviewer
description: >-
  Switch local pack PR reviewer between Codex and Claude via PACK_REVIEWER. Use
  when the user asks to switch reviewer, set codex/claude for review, fix wrong
  reviewer running, or avoid Process overriding User env — e.g. «переключи
  ревьюера», «поставь codex», «используется claude вместо codex»,
  «PACK_REVIEWER», «switch reviewer», «reviewer codex/claude». Runs checklist,
  applies User scope, clears Process override, restarts AO, and verifies
  effective reviewer with show-pack-reviewer-status.ps1.
---

Read and execute [`.claude/skills/switch-pack-reviewer/SKILL.md`](../../../.claude/skills/switch-pack-reviewer/SKILL.md) in full. Do not re-derive the workflow inline.
