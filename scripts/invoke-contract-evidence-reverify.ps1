#requires -Version 5.1
<#
.SYNOPSIS
  Deprecated PR-checkout wrapper for checkpoint-2 (Issue #376).

  Reviewers must not execute this file. Use the trusted-base launcher instead.
#>
param()

$ErrorActionPreference = 'Stop'

$message = @'
Checkpoint-2 must be launched from trusted pack root, not this PR-checkout wrapper.

Use:
  pwsh -NoProfile -File <trusted-pack-root>/scripts/launch-contract-evidence-reverify.ps1 `
    -ReviewTargetRoot <pr-worktree-path> `
    -SnapshotFile <resolved-bound-issue-snapshot.md> `
    ... `
    -Summary

<trusted-pack-root> is a clean origin/main worktree, AO_TRUSTED_PACK_ROOT, or an origin/main archive checkout — never the PR checkout under review.
'@

[Console]::Error.WriteLine($message.Trim())
exit 2
