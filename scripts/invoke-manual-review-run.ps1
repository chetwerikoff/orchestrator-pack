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
. (Join-Path $PSScriptRoot 'lib/Review-StartClaim.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-AutonomousReviewStartGate.ps1')
. (Join-Path $PSScriptRoot 'lib/Orchestrator-ReviewStartAudit.ps1')

if (-not $ReviewCommand) {
    $config = Resolve-PackOrchestratorYamlPath -CliYamlPath $YamlPath -PackRoot $PackRoot
    $ReviewCommand = Get-PackReviewCommandFromYaml -YamlPath $config
}

$openPrs = Invoke-GhOpenPrList -RepoRoot $PackRoot
if (-not $HeadSha) {
    foreach ($pr in @($openPrs)) {
        if ([int]$pr.number -eq $PrNumber) {
            $HeadSha = [string]$pr.headRefOid
            break
        }
    }
}

$runs = @(Get-AoReviewRuns -Project $ProjectId)
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

& ao review run $SessionId --execute --command $ReviewCommand
exit $LASTEXITCODE
