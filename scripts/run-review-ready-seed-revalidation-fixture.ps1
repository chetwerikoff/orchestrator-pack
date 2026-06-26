#requires -Version 5.1
<#
  Deterministic pre-side-effect revalidation fixture runner (Issue #475).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$FixturePath
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
$LibDir = Join-Path $PSScriptRoot 'lib'

. (Join-Path $LibDir 'Invoke-ReviewReadyReportStateSeed.ps1')
. (Join-Path $LibDir 'Review-StartClaim.ps1')
. (Join-Path $LibDir 'MechanicalReconcileNode.ps1')

function Get-ReviewReadySeedRevalidationFixturePayload {
    param($Fixture)

    $payload = @{
        openPrs    = @($Fixture.openPrs)
        reviewRuns = @($Fixture.reviewRuns)
        sessions   = @($Fixture.sessions)
    }
    foreach ($name in @(
            'ciChecksByPr', 'requiredCheckNamesByPr', 'requiredCheckLookupFailedByPr',
            'bindingByKey', 'seededKeys', 'deferredScanKeys', 'handoffRecords',
            'terminalClaimKeys', 'watchEntries', 'tickCapacity', 'nowMs',
            'supervisedRepoSlug', 'freshSnapshot', 'boundaryRace'
        )) {
        if ($null -ne $Fixture.$name) {
            if ($name -in @(
                    'ciChecksByPr', 'requiredCheckNamesByPr', 'requiredCheckLookupFailedByPr',
                    'bindingByKey', 'handoffRecords', 'watchEntries', 'freshSnapshot'
                )) {
                $payload[$name] = ConvertTo-MechanicalJsonMap -Value $Fixture.$name
            }
            else {
                $payload[$name] = $Fixture.$name
            }
        }
    }
    return $payload
}

$fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
$expected = [string]$fixture.expected
$result = @{
    expected = $expected
    ok       = $false
    detail   = ''
}

function Write-RevalidationResult {
    param($Payload)
    $Payload | ConvertTo-Json -Compress -Depth 20
}

try {
    switch ([string]$fixture.scenario) {
        'tick-revalidation' {
            $stateDir = Join-Path ([System.IO.Path]::GetTempPath()) ("seed-reval-$([guid]::NewGuid())")
            New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
            $claimDir = Join-Path $stateDir 'claims'
            New-Item -ItemType Directory -Path $claimDir -Force | Out-Null
            $env:AO_REVIEW_CLAIM_DIR = $claimDir
            try {
                $payload = Get-ReviewReadySeedRevalidationFixturePayload -Fixture $fixture
                if ($fixture.preSeedClaim) {
                    $prNumber = [int]$fixture.openPrs[0].number
                    $headSha = [string]$fixture.openPrs[0].headRefOid
                    $surface = [string]$fixture.preSeedClaim.surface
                    if (-not $surface) { $surface = 'review-trigger-reconcile' }
                    $null = Acquire-ReviewStartClaim -PrNumber $prNumber -HeadSha $headSha `
                        -Surface $surface -Namespace $claimDir -ReviewRuns @()
                }

                $useDryRun = -not [bool]$fixture.preSeedClaim
                $tick = Invoke-ReviewReadyReportStateSeedTick -StateRoot $stateDir `
                    -ProjectId 'orchestrator-pack' -ReviewCommand 'echo fixture-review' `
                    -SupervisedRepoSlug 'chetwerikoff/orchestrator-pack' `
                    -FixturePayload $payload -DryRun:$useDryRun `
                    -LogWriter { param([string]$Message) } -TickId 'seed-reval-fixture'

                $startedOk = ([int]$tick.started -eq [int]$fixture.expectStarted)
                $reval = @($tick.revalidations | Where-Object { $_.outcome })
                $outcome = if ($reval.Count -gt 0) { [string]$reval[0].outcome } else { '' }
                $outcomeOk = ($outcome -eq [string]$fixture.expectOutcome)
                $result.ok = $startedOk -and $outcomeOk
                $result.detail = "started=$($tick.started) outcome=$outcome reason=$($reval[0].reason)"
            }
            finally {
                Remove-Item Env:AO_REVIEW_CLAIM_DIR -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        default {
            throw "Unknown scenario: $($fixture.scenario)"
        }
    }
}
catch {
    $result.ok = $false
    $result.detail = $_.Exception.Message
}

Write-RevalidationResult $result
