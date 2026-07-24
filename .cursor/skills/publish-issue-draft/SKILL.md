---
name: publish-issue-draft
description: >-
  LEGACY DRAFTS ONLY (operator decision 2026-07-23): persistence workflow for
  the pre-existing draft files in docs/issues_drafts/** — edits, batches,
  re-syncs of historical specs. New GPT-authored tasks are mirrorless
  (create-issue-draft produces no local draft file and never chains here — there
  is nothing to persist). DEFAULT is sync-only: the GitHub Issue is the queue; a
  legacy draft file stays local and is NOT committed or PR'd. Only open a PR to
  main on explicit request (batch a series, or full publish of one legacy
  draft). Use when the user asks to publish, commit, batch, or ship a legacy
  draft.
---

Read and execute [`.claude/skills/publish-issue-draft/SKILL.md`](../../../.claude/skills/publish-issue-draft/SKILL.md) in full. Do not re-derive the workflow inline.
