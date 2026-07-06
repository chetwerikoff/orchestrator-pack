---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely pull main in the live checkout, and apply documented
  local operator adoption. After every merge, verify the AO orchestrator runtime
  worktree contains the merge commit (Step 6e); for runtime-sensitive merges,
  recycle affected AO sessions and confirm adoption surfaces (Step 8). After
  merge, kill the merged PR's worker AO session and run ao session cleanup -p
  orchestrator-pack. Use when the user asks to merge a finished task — e.g.
  «мерж», «мерж 385», «мерж и пул», «смерж», «merge», «merge and pull» — or
  clearly wants a ready PR merged after review/CI. When CI is red and/or the
  branch is behind base, delegate the fix to the PR worker (Step 3b) and resume
  merge + local adoption only after CI is green. Operates on the operator's live
  working tree in Cursor; never discards uncommitted local work. Skip when the
  user only asks about merge policy without a concrete PR.
---

Read and execute [`.claude/skills/merge-with-local-adoption/SKILL.md`](../../../.claude/skills/merge-with-local-adoption/SKILL.md) in full. Do not re-derive the workflow inline.
