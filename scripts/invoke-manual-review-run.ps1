#requires -Version 5.1
<#
.SYNOPSIS
  Manual operator review-start with advisory warning on covered heads (Issue #318).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SessionId,
    [Parameter(Mandatory = $true)]
    [int]$PrNumber,
    [string]$HeadSha = '',
    [string]$ProjectId = 'orchestrator-pack',
    [string]$ReviewCommand = '',
    [string]$YamlPath = ''
)

$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/Get-PackReviewCommand.ps1')
. (Join-Path $PSScriptRoot 'lib/Invoke-AoCliJson.ps1')
. (Join-Path $PSScriptRoot 'lib/Gh-PrChecks.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-PostRunRetry.ps1')
. (Join-Path $PSScriptRoot 'lib/Review-StartClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-AutonomousReviewStartGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-ReviewStartAudit.ps1')

if (-not $ReviewCommand) {
    $config = Resolve-PackOrchestratorYamlPath -CliYamlPath $YamlPath -PackRoot $PackRoot
    $ReviewCommand = Get-PackReviewCommandFromYaml -YamlPath $config
}

$scopedLookup = Invoke-ReviewStartScopedGhPrView -RepoRoot $PackRoot -PrNumber $PrNumber
if ($scopedLookup.targetStateDenial) {
    $auditRoot = Get-OrchestratorReviewStartAuditRoot -ProjectId $ProjectId
    Write-OrchestratorReviewStartDenialAudit -AuditRoot $auditRoot -PrNumber $PrNumber -HeadSha $HeadSha `
        -Reason ([string]$scopedLookup.targetStateDenial.reason) -ClaimOutcome 'manual_denied' -Provenance 'manual-operator' | Out-Null
    throw "manual review start denied: $([string]$scopedLookup.targetStateDenial.reason)"
}
if ($scopedLookup.transportFailure) {
    $auditRoot = Get-OrchestratorReviewStartAuditRoot -ProjectId $ProjectId
    Write-OrchestratorReviewStartDenialAudit -AuditRoot $auditRoot -PrNumber $PrNumber -HeadSha $HeadSha `
        -Reason ([string]$scopedLookup.transportFailure.reason) -ClaimOutcome 'manual_denied' -Provenance 'manual-operator' | Out-Null
    throw "manual review start infrastructure denial: $([string]$scopedLookup.transportFailure.reason)"
}
$openPrs = @($scopedLookup.openPrs)
if (-not $HeadSha) {
    foreach ($pr in @($openPrs)) {
        if ([int]$pr.number -eq $PrNumber) {
            $HeadSha = [string]$pr.headRefOid
            break
        }
    }
}
if (-not $HeadSha) {
    throw "manual review start denied: head_resolution_failed"
}

$runs = @(Get-EnrichedAoReviewRuns -Project $ProjectId -RepoRoot $PackRoot)
$payload = @{
    reviewRuns = $runs
    prNumber   = $PrNumber
    headSha    = $HeadSha
}
$coverage = Invoke-OrchestratorClaimedReviewRunFilterCli -Subcommand 'evaluateCoverage' -Payload $payload
$namespace = Resolve-ReviewStartClaimNamespace -ProjectId $ProjectId
$claimPath = Get-ReviewStartClaimPath -Namespace $namespace -PrNumber $PrNumber -HeadSha $HeadSha
$activeClaim = Test-Path -LiteralPath $claimPath
if ($coverage.verdict -eq 'covered' -or $activeClaim) {
    $auditRoot = Get-OrchestratorReviewStartAuditRoot -ProjectId $ProjectId
    Write-OrchestratorReviewStartDenialAudit -AuditRoot $auditRoot -PrNumber $PrNumber -HeadSha $HeadSha `
        -Reason 'manual_override_covered_or_pending' -ClaimOutcome 'manual_warning' -Provenance 'manual-operator' | Out-Null
    Write-Warning "manual review start on covered or pending head PR #$PrNumber head=$HeadSha (claimActive=$activeClaim coverage=$($coverage.verdict))"
}

$failed = @($runs | Where-Object { $_.prNumber -eq $PrNumber -and $_.targetSha -eq $HeadSha -and $_.status -in @('failed','cancelled') } | Select-Object -First 1)
Write-ManualOperatorReviewRetryAudit -Namespace $namespace -PrNumber $PrNumber -HeadSha $HeadSha `
    -FailureClass ([string]$failed.failureClass) -RunId ([string]$failed.id) | Out-Null

& ao review run $SessionId --execute --command $ReviewCommand
exit $LASTEXITCODE
