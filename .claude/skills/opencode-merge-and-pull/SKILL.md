---
name: opencode-merge-and-pull
description: >-
  Standalone OpenCode merge entrypoint for a concrete Issue or PR number. Reuse
  the canonical merge-with-local-adoption workflow so readiness, operator
  adoption, runtime-specific worktree handling, cleanup, and read-back have one
  authority. Never discard unrelated local work.
---

# OpenCode merge and pull

Read and execute [`.claude/skills/merge-with-local-adoption/SKILL.md`](../merge-with-local-adoption/SKILL.md) in full.

This entrypoint adds no alternate merge policy, runtime command path, local-adoption contract, or cleanup behavior. When invoked from OpenCode, perform the canonical workflow directly in the current top-level session rather than spawning a nested agent.
