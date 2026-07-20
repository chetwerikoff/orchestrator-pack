---
name: merge-with-local-adoption
description: >-
  Merge a ready PR, safely pull main in the live checkout, and apply documented
  local operator adoption; verify the AO orchestrator runtime worktree contains
  the merge commit (Step 6e), recycle affected sessions for runtime-sensitive
  merges (Step 8), then kill the merged PR's worker session (no blanket ao
  session cleanup while the orchestrator is live — Step 9c). Use when the user
  asks to merge a finished task — «мерж», «мерж 385», «мерж и пул», «смерж»,
  «merge», «merge and pull» — or clearly wants a ready PR merged after
  review/CI. On a direct merge order, normalize blocking statuses instead of
  stopping — draft → ready for review, BEHIND → update-branch, review and
  proven-non-required blocks → `--admin` — while required CI that is not green
  (red, pending, or never reported) still stops (Step 3a). If CI is red or the
  branch is behind base, delegate the fix to the PR worker (Step 3b) and merge
  only after CI is green. Operates on the operator's live working tree; never
  discards uncommitted local work. Skip when the user only discusses merge
  policy without a concrete PR.
---

Read and execute [`.claude/skills/merge-with-local-adoption/SKILL.md`](../../../.claude/skills/merge-with-local-adoption/SKILL.md) in full. Do not re-derive the workflow inline.
