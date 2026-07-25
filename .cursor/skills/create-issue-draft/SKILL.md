---
name: create-issue-draft
description: Use when accepting a GPT-chat-authored task for `orchestrator-pack` — the user hands over a GitHub Issue link plus the browser-GPT task-chat link (or only a brief: GPT then authors and creates the Issue by default), and the architect runs lens → task-chat fix → fresh browser-GPT competitive/architectural review passes → final lens → fresh browser-GPT final verification when required. Covers Issue-only live task state, mixed-engine Codex additions/substitutions, T3-critical L4 classification and safety floors, tracked `chatgpt-browser-turn` mechanics, issue-body guards, and the finding-disposition ledger. The Issue is the only live task artifact; audit artifacts live in an out-of-repo workdir. Invoke for on-ladder GPT-authored tasks; use the canonical below-ladder skip line from `docs/tiering.md`. Do not invoke when that skip line applies.
---

Read and execute [`.claude/skills/create-issue-draft/SKILL.md`](../../../.claude/skills/create-issue-draft/SKILL.md) in full. Do not re-derive the workflow inline.
