# Switch pack reviewer — operator checklist

1. Inspect the effective selector:

   ```powershell
   pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1
   ```

2. Set `PACK_REVIEWER` and restart the pack supervisor:

   ```powershell
   pwsh -NoProfile -File scripts/set-pack-reviewer.ps1 \
     -Reviewer <codex|claude> \
     -RestartSupervisor
   ```

3. Verify the effective selector:

   ```powershell
   pwsh -NoProfile -File scripts/show-pack-reviewer-status.ps1 \
     -Expected <codex|claude>
   ```

Restarting AO is not reviewer adoption. `-RestartAo` is deprecated and maps only to
supervisor restart. Reviews continue to start through `scripts/pack-review-runner.ts` and
invoke `scripts/invoke-pack-review.ps1`.

Full contract: [`pack-review-runbook.md`](pack-review-runbook.md).
