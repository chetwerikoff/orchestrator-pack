---
name: create-issue-draft
description: Use when accepting a GPT-chat-authored task for `orchestrator-pack` — the user hands over a GitHub Issue link plus the browser-GPT authoring-chat link, and the architect runs the lens → fix → competitive → architectural-review → final-lens pipeline over it, with GPT applying every fix directly to the Issue. Covers chat topology (one task chat, fresh chat per competitive pass, one dedicated review chat), the six-axis architect lens, browser-turn mechanics via the cursor helper, mandatory issue-body floors (tier gate, fences, contract evidence, discipline guards), the finding-disposition ledger, and issue→draft reconciliation. Invoke on every new GPT-authored task. Do not invoke for tiny docs typos or rename-only refactors.
---

Read and execute [`.claude/skills/create-issue-draft/SKILL.md`](../../../.claude/skills/create-issue-draft/SKILL.md) in full. Do not re-derive the workflow inline.
