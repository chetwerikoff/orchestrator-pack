#requires -Version 5.1
<#
.SYNOPSIS
  Merge-blocking live smoke for harness [Pn] post-submit enforcement (Issue #683).

.DESCRIPTION
  Requires a real AO daemon and PACK_HARNESS_PN_SMOKE_SESSION. Uses the shipped
  mapper machinery (validateHarnessSubmitBody) — never prose-regex scraping.
  Fail-closed when AO/daemon is unavailable; fixtures cannot satisfy this check.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoReviewApi.ps1')
. (Join-Path $PSScriptRoot 'lib/MechanicalReconcileNode.ps1')

$ContentShapeCli = Join-Path $Root 'docs/harness-post-submit-pn-content-shape.mjs'

function Invoke-HarnessPnLiveSmokeCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $ContentShapeCli -Subcommand $Subcommand `
        -Payload $Payload -Label 'harness-pn-live-smoke' -JsonDepth 20
}

function Test-HarnessPnLiveSmokeRequired {
    if ($env:PACK_HARNESS_PN_SMOKE_ENABLED -eq 'true') {
        return $true
    }
    if ($env:PACK_HARNESS_PN_SMOKE_SESSION) {
        return $true
    }
    return $false
}

if (-not (Test-HarnessPnLiveSmokeRequired)) {
    Write-Host '[SKIP] live harness [Pn] smoke not operator-enabled (PACK_HARNESS_PN_SMOKE_ENABLED unset and no session)'
    exit 0
}

try {
    $health = Get-AoDaemonHealthJson
    $baseUrl = Get-AoDaemonApiBaseUrl -HealthPayload $health
}
catch {
    Write-Host "[FAIL] AO daemon unavailable for live harness [Pn] smoke: $($_.Exception.Message)"
    exit 1
}

$projectId = if ($env:PACK_HARNESS_PN_SMOKE_PROJECT) { $env:PACK_HARNESS_PN_SMOKE_PROJECT } else { 'orchestrator-pack' }
$sessionId = $env:PACK_HARNESS_PN_SMOKE_SESSION
if (-not $sessionId) {
    Write-Host '[FAIL] PACK_HARNESS_PN_SMOKE_SESSION is required for live smoke (fail-closed)'
    exit 1
}

$reviews = Get-AoSessionReviewsJson -SessionId $sessionId -BaseUrl $baseUrl
$harnessRows = @($reviews.reviews | Where-Object {
        $lr = $_.latestRun
        $lr -and [string]$lr.harness -and @('complete', 'delivered') -contains [string]$lr.status
    })
if ($harnessRows.Count -eq 0) {
    Write-Host "[FAIL] no terminal harness latestRun rows visible for session=$sessionId project=$projectId"
    exit 1
}

$invalid = @()
foreach ($row in $harnessRows) {
    $shape = Invoke-HarnessPnLiveSmokeCli -Subcommand 'evaluate-latest-run' -Payload @{
        latestRun = $row.latestRun
    }
    if ($shape.action -ne 'accept') {
        $invalid += [pscustomobject]@{
            prNumber = $row.prNumber
            runId    = $row.latestRun.id
            reason   = $shape.reason
        }
    }
}

if ($invalid.Count -gt 0) {
    Write-Host "[FAIL] live harness rows lack [Pn]/mapper or clean shape count=$($invalid.Count)"
    foreach ($row in $invalid) {
        Write-Host "  pr=$($row.prNumber) run=$($row.runId) reason=$($row.reason)"
    }
    exit 1
}

Write-Host "[PASS] live harness [Pn] smoke saw $($harnessRows.Count) valid terminal harness row(s)"
exit 0
