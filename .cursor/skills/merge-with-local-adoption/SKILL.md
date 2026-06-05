---
name: merge-with-local-adoption
description: >-
  Merge a ready PR and surface post-merge local operator steps. Use when the
  user asks to merge a finished task — e.g. «мерж», «мерж и пул», «смерж»,
  «смержи», «merge», «merge and pull» — or clearly wants a ready PR merged after
  review/CI. Before merging, scan the PR and linked issue for operator-facing
  adoption (live YAML, listeners, env, restarts); if any exist, explain why and
  give numbered steps. Skip when the user only asks about merge policy without a
  concrete PR.
---

Read and execute [`.claude/skills/merge-with-local-adoption/SKILL.md`](../../../.claude/skills/merge-with-local-adoption/SKILL.md) in full. Do not re-derive the workflow inline.
