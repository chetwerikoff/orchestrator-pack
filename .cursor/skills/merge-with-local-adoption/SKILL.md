---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely adopt merged main in the live operator checkout, apply
  documented local adoption, then quiesce and remove the exact merged PR Orca
  worktree. The post-merge lifecycle binds the original worker head H0 and live
  merged PR head H1, permits dirty/active target-only cleanup after exact safety
  proof, and preserves primary/sibling worktrees plus unrelated panes/processes.
  Use for concrete merge requests such as «мерж 385», «смерж», «мерж и пул»,
  “merge”, or “merge and pull”. Required CI that is not green still blocks merge;
  draft/behind normalization follows the canonical flow. Never use for merge-policy
  discussion without a concrete PR.
---

Read and execute [`.claude/skills/merge-with-local-adoption/SKILL.md`](../../../.claude/skills/merge-with-local-adoption/SKILL.md) in full. Do not re-derive the workflow inline.
