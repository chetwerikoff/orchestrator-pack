---
name: switch-pack-reviewer
description: >-
  Switch the pack-owned reviewer between Codex and Claude through PACK_REVIEWER,
  restart the pack side-process supervisor, and verify the effective selector.
---

# Switch pack reviewer

Read the complete current contract in
[`docs/pack-review-runbook.md`](../../../docs/pack-review-runbook.md).

Required procedure:

```powershell
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 \
  -Reviewer <codex|claude> \
  -RestartSupervisor
pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1 \
  -Expected <codex|claude>
```

`PACK_REVIEWER` selects the wrapper used by `scripts/invoke-pack-review.ps1`; reviews
start through `scripts/pack-review-runner.ts`. Restart the pack supervisor so children
inherit the selector. Do not restart AO or edit YAML to adopt a reviewer change.
`-RestartAo` is deprecated and must map only to supervisor restart.

Report the effective reviewer, verification result, and whether supervisor restart
succeeded.
