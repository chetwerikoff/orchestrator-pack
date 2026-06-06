#requires -Version 5.1
<#
.SYNOPSIS
  Read-only Gate 0 diagnostic for legacy bulk `ao review send` and stuck open findings.

.DESCRIPTION
  Surfaces review runs where AO 0.9.2 cannot enact per-finding routing (bulk all-open send,
  no programmatic dismiss/backlog). No `ao review send`, dismiss, or file writes.
  See docs/architecture.md#finding-routing-enactment--gate-0-ao-092-2026-06-02 (Issue #140).
#>
[CmdletBinding()]
param(
    [string]$ProjectId = '',
    [string]$FixturePath = '',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'
$packRoot = [string](Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$detectCli = Join-Path $packRoot 'docs/review-bulk-send-diagnose.mjs'

. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')

if (-not (Test-Path -LiteralPath $detectCli -PathType Leaf)) {
    throw "Missing $detectCli"
}

function Invoke-BulkSendDiagnoseCli {
    param([hashtable]$Payload)

    $json = $Payload | ConvertTo-Json -Depth 30 -Compress
    $output = $json | & node $detectCli diagnose 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "review-bulk-send-diagnose.mjs diagnose exited ${LASTEXITCODE}: $output"
    }

    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    return $text | ConvertFrom-Json
}

if ($FixturePath) {
    if (-not (Test-Path -LiteralPath $FixturePath -PathType Leaf)) {
        throw "Fixture not found: $FixturePath"
    }
    $fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
    $runs = @($fixture.runs)
    if (-not $runs -and $fixture.data) { $runs = @($fixture.data) }
}
else {
    $payload = Get-AoReviewListJson -Project $ProjectId
    $runs = @(Get-AoReviewRunsFromPayload -Payload $payload -Project $ProjectId)
}

$result = Invoke-BulkSendDiagnoseCli -Payload @{
    runs       = $runs
    projectId  = $ProjectId
}

if ($Json) {
    $result | ConvertTo-Json -Depth 20
    exit 0
}

Write-Host '== Review bulk-send / stuck-open diagnostic (read-only, Issue #140) =='
Write-Host ''
Write-Host ("Gate 0 verdict: {0}" -f $result.gate0.verdict)
Write-Host ("Runs scanned: {0}; flagged: {1}" -f $result.summary.totalRuns, $result.summary.flaggedRuns)

if ($result.summary.flaggedRuns -eq 0) {
    Write-Host ''
    Write-Host 'No bulk-send trap or stuck-open runs detected in current `ao review list` snapshot.'
}
else {
    Write-Host ''
    Write-Host '-- Flagged runs --'
    foreach ($entry in $result.flaggedRuns | Select-Object -First 12) {
        $pr = if ($entry.prNumber) { "PR #$($entry.prNumber)" } else { '-' }
        $id = if ($entry.runId) {
            $entry.runId.Substring(0, [Math]::Min(38, $entry.runId.Length))
        }
        else {
            '(no id)'
        }
        Write-Host ("  {0,-38} {1,-16} open={2} sent={3} {4}" -f `
                $id, $entry.status, $entry.openFindingCount, $entry.sentFindingCount, $pr)
        foreach ($signal in $entry.signals) {
            Write-Host ("    [{0}] {1}" -f $signal.kind, $signal.detail)
        }
    }
    if ($result.summary.flaggedRuns -gt 12) {
        Write-Host ("  ... and {0} more (use -Json for full output)" -f ($result.summary.flaggedRuns - 12))
    }
}

Write-Host ''
Write-Host '-- Upstream unblock (pack #140) --'
Write-Host '  Pipeline (preferred): builtin/router #1631 + artifact dismiss|send #1346'
Write-Host '  Legacy fallback: ao review per-finding API #2088'
Write-Host '  Delivery trust: skipped-reason observability #1943 / #614'
Write-Host ("  Pack tracking: {0}" -f $result.upstream.packIssue)
