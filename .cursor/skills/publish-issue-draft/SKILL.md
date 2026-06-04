---
name: publish-issue-draft
description: >-
  After create-issue-draft finishes (Codex draft review done, GitHub issue
  synced), decide how the local draft is persisted. DEFAULT is sync-only: the
  GitHub Issue is the queue; the draft file stays local and is NOT committed or
  PR'd. Only open a PR to main on explicit request (batch a series, or full
  publish of one draft). Use when the user asks to publish, commit, batch, or
  ship a draft. Chains from create-issue-draft.
---

Read and execute [`.claude/skills/publish-issue-draft/SKILL.md`](../../../.claude/skills/publish-issue-draft/SKILL.md) in full. Do not re-derive the workflow inline.
