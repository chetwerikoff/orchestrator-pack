# GitHub Issues + Cursor workers + pack reviewer setup

- GitHub Issues are the task source of truth.
- Cursor is the default planner/worker unless supported ProjectConfig overrides it.
- Worker policy comes from tracked `AGENTS.md`.
- Live AO 0.10.3 settings use supported ProjectConfig fields.
- `agent-orchestrator.yaml.example` is a legacy-import fixture, not live policy.

## Pack reviewer

`PACK_REVIEWER=codex|claude` selects the reviewer behind
`scripts/invoke-pack-review.ps1`. Reviews start through
`scripts/pack-review-runner.ts`; restart the pack side-process supervisor after changing
the selector.

AO review HTTP API, `ao review submit`, and project reviewer configuration remain
available upstream in AO 0.10.3, but are retired by this pack. They are not fallback,
dual-write, status, delivery, binding, or merge-authority paths.

Complete review setup, commands, evidence, switching, and branch-protection guidance:
[`pack-review-runbook.md`](pack-review-runbook.md).

## Task convention

Issues should contain a clear goal, testable acceptance criteria, and explicit path
scope/denylist. PR bodies must link the task near the top with `Closes #N`, `Fixes #N`, or
`Resolves #N`.

## Verify

```powershell
pwsh -NoProfile -File scripts/verify.ps1 -StrictPrereqs
pwsh -NoProfile -File scripts/check-reusable.ps1
```

Do not patch AO core to add reviewer routing.
