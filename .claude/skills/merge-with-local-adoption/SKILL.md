---
name: merge-with-local-adoption
description: >-
  Merge a PR, safely adopt merged main in the operator checkout, apply documented
  local adoption, then quiesce and remove the selected merged-PR worktree. Ordinary
  repository gates remain useful evidence; a direct top-level user instruction
  overrides repository-owned merge and cleanup refusals while preserving truthful
  reporting and exact final read-back. Never broaden cleanup to the primary checkout,
  sibling worktrees, or unrelated panes/processes.
  Use for concrete merge requests such as «мерж 385», «смерж», or “merge and pull”.
---

Read and execute [`.cursor/skills/merge-with-local-adoption/SKILL.md`](../../../.cursor/skills/merge-with-local-adoption/SKILL.md) in full. Do not re-derive the workflow inline.
