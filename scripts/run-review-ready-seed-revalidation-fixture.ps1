#requires -Version 5.1
<#
  Issue #475: deterministic pre-side-effect revalidation fixture runner for report-state seed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$FixturePath
)

$ErrorActionPreference = 'Stop'
$LibDir = Join-Path $PSScriptRoot 'lib'

. (Join-Path $LibDir 'Invoke-ReviewReadyReportStateSeed.ps1')
. (Join-Path $LibDir 'Review-StartClaim.ps1')
. (Join-Path $LibDir 'Review-ReadySeedFixturePayload.ps1')

$fixture = Resolve-ReviewReadySeedFixture -FixturePath $FixturePath
$result = @{
    expected = [string]$fixture.expected
    ok       = $false
    detail   = ''
}

try {
    if ([string]$fixture.scenario -ne 'tick-revalidation') {
        throw "Unknown scenario: $($fixture.scenario)"
    }

    $stateDir = Join-Path ([System.IO.Path]::GetTempPath()) ("seed-reval-$([guid]::NewGuid())")
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $claimDir = Join-Path $stateDir 'claims'
    New-Item -ItemType Directory -Path $claimDir -Force | Out-Null
    $env:AO_REVIEW_CLAIM_DIR = $claimDir
    try {
        $payload = Get-ReviewReadySeedFixturePayload -Fixture $fixture
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
catch {
    $result.ok = $false
    $result.detail = $_.Exception.Message
}

Write-ReviewReadySeedFixtureResult -Result $result
