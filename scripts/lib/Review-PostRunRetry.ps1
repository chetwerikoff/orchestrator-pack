#requires -Version 5.1
<#
  Pack-owned post-run review retry enrichment bridge (Issue #539).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Review-RunLiveness.ps1')

$Script:AutonomousReviewRetryCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/autonomous-review-retry.mjs'
$Script:PostRunRetryLedgerCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/post-run-retry-ledger.mjs'

function Invoke-AutonomousReviewRetryCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:AutonomousReviewRetryCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'autonomous-review-retry' -JsonDepth 30
}

function Invoke-PostRunRetryLedgerCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:PostRunRetryLedgerCli `
        -Subcommand $Subcommand -Payload $Payload -Label 'post-run-retry-ledger' -JsonDepth 30
}

function Get-PostRunRetryLedgerPath {
    param([string]$Namespace)
    if (-not $Namespace) { throw 'Get-PostRunRetryLedgerPath requires Namespace' }
    return Join-Path $Namespace 'post-run-retry-ledger.json'
}

function Get-EnrichedAoReviewRuns {
    param(
        [string]$Project = '',
        [string]$RepoRoot = '',
        [hashtable]$EvidenceByRunId = @{}
    )

    . (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
    $runs = @(Get-AoReviewRuns -Project $Project)
    if ($runs.Count -eq 0) {
        return @()
    }

    $options = @{ evidenceByRunId = $EvidenceByRunId }
    if ($RepoRoot) {
        $storeDir = Get-ReviewRecoveryStoreDirFromRepoRoot -RepoRoot $RepoRoot
        if ($storeDir) {
            $options.storeDir = $storeDir
        }
    }

    $payload = @{ runs = $runs; options = $options }
    $enriched = Invoke-AutonomousReviewRetryCli -Subcommand 'enrichReviewRuns' -Payload $payload
    return @($enriched)
}

function Write-ManualOperatorReviewRetryAudit {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$FailureClass = '',
        [string]$RunId = ''
    )

    if (-not $Namespace) { return @{ ok = $false; reason = 'namespace_missing' } }
    $ledgerPath = Get-PostRunRetryLedgerPath -Namespace $Namespace
    $ledger = @{}
    if (Test-Path -LiteralPath $ledgerPath) {
        $ledger = Get-Content -LiteralPath $ledgerPath -Raw | ConvertFrom-Json
        if ($ledger.entries) {
            $entries = @{}
            foreach ($prop in $ledger.entries.PSObject.Properties) {
                $entries[$prop.Name] = $prop.Value
            }
            $ledger = @{ schemaVersion = $ledger.schemaVersion; entries = $entries; manualAudit = @($ledger.manualAudit) }
        }
    }

    $result = Invoke-PostRunRetryLedgerCli -Subcommand 'recordManualOperatorRetryAudit' -Payload @{
        ledger       = $ledger
        prNumber     = $PrNumber
        headSha      = $HeadSha
        failureClass = $FailureClass
        runId        = $RunId
    }

    if ($result.ledger) {
        $dir = Split-Path -Parent $ledgerPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        ($result.ledger | ConvertTo-Json -Compress -Depth 30) | Set-Content -LiteralPath $ledgerPath -Encoding UTF8
    }
    return $result
}
