#requires -Version 5.1
<#
.SYNOPSIS
  PR guard: operator-facing runtime or supervised-process changes require an
  adoption note or an explicit no-adoption waiver.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$ChangedPaths,
    [string]$PrBody = ''
)

$ErrorActionPreference = 'Stop'
$MigrationRel = 'docs/migration_notes.md'
$WaiverLine = 'No operator adoption required'
$OperatorFacingPaths = @(
    'scripts/runtime/registry.ts',
    'scripts/orchestrator-side-process-registry.json',
    'scripts/orchestrator-wake-supervisor.ps1',
    '.claude/skills/change-orchestrator-runtime/SKILL.md',
    '.cursor/skills/change-orchestrator-runtime/SKILL.md'
)

function Normalize-RepoPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    $normalized = $Path.Trim().Replace('\', '/')
    if ($normalized.StartsWith('./')) { return $normalized.Substring(2) }
    return $normalized
}

$normalized = @($ChangedPaths | ForEach-Object { Normalize-RepoPath $_ })
$triggered = @($OperatorFacingPaths | Where-Object { $normalized -contains $_ })
if ($triggered.Count -eq 0) {
    Write-Host '[PASS] no operator-facing runtime or supervisor surface changed'
    exit 0
}

if ($normalized -contains $MigrationRel) {
    Write-Host "[PASS] operator-facing change paired with $MigrationRel"
    exit 0
}

$bodyText = $PrBody
if ($bodyText.Length -gt 0 -and [int][char]$bodyText[0] -eq 0xFEFF) {
    $bodyText = $bodyText.Substring(1)
}
$bodyLines = @(($bodyText -split '\r?\n') | ForEach-Object { $_.TrimEnd() })
if ($bodyLines -contains $WaiverLine) {
    Write-Host '[PASS] operator-facing change carries the exact no-adoption waiver'
    exit 0
}

Write-Host '[FAIL] operator-facing runtime or supervisor surface changed without adoption evidence'
Write-Host ('  Triggered paths: {0}' -f ($triggered -join ', '))
Write-Host "  Add operator adoption steps to $MigrationRel, or put this line on its own in the PR body:"
Write-Host "  $WaiverLine"
exit 1
