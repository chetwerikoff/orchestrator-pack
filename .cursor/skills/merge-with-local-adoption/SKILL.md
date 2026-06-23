---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely pull main in the live checkout, and apply documented
  local operator adoption. For runtime-sensitive merges, verify the AO
  orchestrator runs on the current commit after operator restart. Use when the
  user asks to merge a finished task — e.g. «мерж», «мерж 385», «мерж и пул»,
  «смерж», «merge», «merge and pull» — or clearly wants a ready PR merged after
  review/CI. Operates on the operator's live working tree in Cursor; never
  discards uncommitted local work. Skip when the user only asks about merge
  policy without a concrete PR.
---

Read and execute [`.claude/skills/merge-with-local-adoption/SKILL.md`](../../../.claude/skills/merge-with-local-adoption/SKILL.md) in full. Do not re-derive the workflow inline.
