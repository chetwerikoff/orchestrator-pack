#requires -Version 5.1
<#
.SYNOPSIS
  Claimed review-start entry point for the LLM-orchestrator turn (Issue #318).

.DESCRIPTION
  Acquires the shared review-start claim, applies covered-head + head-ready gates,
  and launches ao review run with a process-boundary bypass token. Autonomous
  orchestrator sessions must use this script instead of bare `ao review run`.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SessionId,
    [Parameter(Mandatory = $true)]
    [int]$PrNumber,
    [string]$EventHeadSha = '',
    [string]$ProjectId = 'orchestrator-pack',
    [string]$RepoRoot = '',
    [string]$ReviewCommand = '',
    [string]$YamlPath = '',
    [string]$FixturePath = '',
    [switch]$DryRun,
    [switch]$Probe
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = $PackRoot }

. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-OrchestratorClaimedReviewRun.ps1')

if (-not $ReviewCommand) {
    $config = if ($YamlPath) { $YamlPath } elseif (Test-Path -LiteralPath (Join-Path $PackRoot 'agent-orchestrator.yaml')) {
        Join-Path $PackRoot 'agent-orchestrator.yaml'
    }
    else {
        Join-Path $PackRoot 'agent-orchestrator.yaml.example'
    }
    $ReviewCommand = Get-PackReviewCommandFromYaml -YamlPath $config
}

$fixture = $null
if ($FixturePath) {
    $fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json -AsHashtable
}

if ($Probe) {
    $env:AO_AUTONOMOUS_ORCHESTRATOR_SURFACE = '1'
    $fixture = @{
        openPrs    = @(@{ number = 999999; headRefOid = '0000000000000000000000000000000000000999'; state = 'OPEN' })
        reviewRuns = @(@{
                prNumber   = 999999
                targetSha  = '0000000000000000000000000000000000000999'
                status     = 'clean'
                id         = 'probe-run'
                createdAt  = '2026-06-16T00:00:00.000Z'
            })
        sessions   = @()
        ciChecksByPr = @{ '999999' = @(@{ name = 'Verify orchestrator-pack structure'; state = 'SUCCESS' }) }
        requiredCheckNamesByPr = @{ '999999' = @('Verify orchestrator-pack structure') }
        requiredCheckLookupFailedByPr = @{ '999999' = $false }
    }
    $PrNumber = 999999
    $SessionId = 'probe-session'
}

$result = Invoke-OrchestratorClaimedReviewRun -SessionId $SessionId -ReviewCommand $ReviewCommand `
    -PrNumber $PrNumber -EventHeadSha $EventHeadSha -Project $ProjectId -RepoRoot $RepoRoot `
    -FixtureSnapshot $fixture -DryRun:$DryRun -LogWriter $(if ($Probe) { { param($m) } } else { $null })

$result | ConvertTo-Json -Compress -Depth 6
if (-not $result.started -and -not $DryRun) {
    exit 2
}
