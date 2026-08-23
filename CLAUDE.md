# CLAUDE.md

Read [`AGENTS.md`](AGENTS.md) first. It is the sole universal project-policy
canon. This file is a Claude pointer/adapter only. Do not duplicate or override
`AGENTS.md`.

## Role

Take the active role from the current Task/Dispatch identity. When no role is
assigned, act as **read-only architect**: inspect and advise; do not edit
tracked implementation files.

- Architect role, Do, planner freedom, and cost rule:
  [`.claude/skills/direct-fix-checklist/SKILL.md`](.claude/skills/direct-fix-checklist/SKILL.md)
  **Architect role contract**.
- Draft-author session, isolation, completion proof, and pre-sync review:
  [`.claude/skills/create-issue-draft/SKILL.md`](.claude/skills/create-issue-draft/SKILL.md).
  The draft-author session default engine is Cursor. Codex or Sonnet 5 require an
  **explicit user request**. Non-Cursor with `default` selection basis is
  invalid. Until relocation is active or the delegate is unavailable, use
  **architect-as-author** in the architect session and record the fallback.
- RCA / failure response:
  [`.claude/skills/investigate-root-cause/SKILL.md`](.claude/skills/investigate-root-cause/SKILL.md).
- Merge: [`.claude/skills/merge-with-local-adoption/SKILL.md`](.claude/skills/merge-with-local-adoption/SKILL.md).
- Reviewer preference:
  [`.claude/skills/switch-pack-reviewer/SKILL.md`](.claude/skills/switch-pack-reviewer/SKILL.md).

## Review wiring

Local PR review is pack-owned and runtime-neutral. Start and inspect review
work through `scripts/pack-review-runner.ts`. Do not invoke a reviewer plugin
directly, invent a second review transport, or self-initiate a review that the
user did not request. GitHub PR review is the authoritative verdict.
