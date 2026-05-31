#requires -Version 5.1
<#
.SYNOPSIS
  PR guard: agent-orchestrator.yaml.example changes require migration_notes or waiver.

.DESCRIPTION
  When the PR diff includes agent-orchestrator.yaml.example, the PR must also change
  docs/migration_notes.md or include the exact waiver line on its own in the PR body:
    No operator adoption required
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$ChangedPaths,

    [string]$PrBody = ''
)

$ErrorActionPreference = 'Stop'

$ExampleRel = 'agent-orchestrator.yaml.example'
$MigrationRel = 'docs/migration_notes.md'
$WaiverLine = 'No operator adoption required'

function Normalize-RepoPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ''
    }
    $p = $Path.Trim().Replace('\', '/')
    if ($p.StartsWith('./')) {
        $p = $p.Substring(2)
    }
    return $p
}

$normalized = @($ChangedPaths | ForEach-Object { Normalize-RepoPath $_ })
$exampleChanged = $normalized -contains $ExampleRel

if (-not $exampleChanged) {
    Write-Host "[PASS] $ExampleRel not in PR diff — operator adoption pairing not required"
    exit 0
}

if ($normalized -contains $MigrationRel) {
    Write-Host "[PASS] $ExampleRel change paired with $MigrationRel"
    exit 0
}

$bodyText = $PrBody
if ($bodyText.Length -gt 0 -and [int][char]$bodyText[0] -eq 0xFEFF) {
    $bodyText = $bodyText.Substring(1)
}

$bodyLines = @(
    ($bodyText -split '\r?\n') | ForEach-Object { $_.TrimEnd() }
)

if ($bodyLines -contains $WaiverLine) {
    Write-Host "[PASS] $ExampleRel change waived: PR body contains exact waiver line"
    exit 0
}

Write-Host "[FAIL] $ExampleRel changed but $MigrationRel is not in the PR diff"
Write-Host "  Add operator adoption steps to docs/migration_notes.md, or put this line on its own in the PR body:"
Write-Host "  $WaiverLine"
exit 1
