# Switching the pack reviewer

`PACK_REVIEWER=codex|claude` selects the reviewer used by
`scripts/invoke-pack-review.ps1`. Reviews still start through
`scripts/pack-review-runner.ts`.

Preferred operator command:

```powershell
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 \
  -Reviewer <codex|claude> \
  -RestartSupervisor
```

The pack side-process supervisor must be restarted so new children inherit the selected
environment. Restarting AO is not reviewer adoption. `-RestartAo` is a deprecated
compatibility alias that restarts the pack supervisor, not AO.

Inspect the selector with:

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1 \
  -Expected <codex|claude>
```

The complete reviewer-selection, smoke-review, recovery, and evidence contract is in
[`pack-review-runbook.md`](pack-review-runbook.md). Do not use YAML reviewer configuration
or AO Reviews as a pack-review switching path.
