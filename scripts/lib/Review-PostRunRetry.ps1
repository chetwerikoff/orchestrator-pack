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

function Get-PostRunRetryLedger {
    param([string]$Namespace = '')

    $empty = @{ schemaVersion = 'post-run-retry-ledger/v1'; entries = @{}; manualAudit = @() }
    if (-not $Namespace) { return $empty }

    $ledgerPath = Get-PostRunRetryLedgerPath -Namespace $Namespace
    if (-not (Test-Path -LiteralPath $ledgerPath)) { return $empty }

    $ledger = Get-Content -LiteralPath $ledgerPath -Raw | ConvertFrom-Json
    if ($ledger.entries) {
        $entries = @{}
        foreach ($prop in $ledger.entries.PSObject.Properties) {
            $entries[$prop.Name] = $prop.Value
        }
        return @{
            schemaVersion = $ledger.schemaVersion
            entries       = $entries
            manualAudit   = @($ledger.manualAudit)
        }
    }
    return $empty
}

function ConvertTo-PostRunRetryLedgerHashtable {
    param([object]$Ledger)

    if ($null -eq $Ledger) {
        return $null
    }

    if ($Ledger -is [hashtable] -and $Ledger.entries -is [hashtable]) {
        return $Ledger
    }

    $schemaVersion = if ($Ledger.schemaVersion) { [string]$Ledger.schemaVersion } else { 'post-run-retry-ledger/v1' }
    $entries = @{}
    if ($Ledger.entries) {
        foreach ($prop in $Ledger.entries.PSObject.Properties) {
            $entries[$prop.Name] = $prop.Value
        }
    }
    return @{
        schemaVersion = $schemaVersion
        entries       = $entries
        manualAudit   = @($Ledger.manualAudit)
    }
}

function Set-PostRunRetryLedger {
    param(
        [string]$Namespace,
        [object]$Ledger
    )

    $normalized = ConvertTo-PostRunRetryLedgerHashtable -Ledger $Ledger
    if (-not $Namespace -or -not $normalized) { return }
    $ledgerPath = Get-PostRunRetryLedgerPath -Namespace $Namespace
    $dir = Split-Path -Parent $ledgerPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    ($normalized | ConvertTo-Json -Compress -Depth 30) | Set-Content -LiteralPath $ledgerPath -Encoding UTF8
}

function Register-PostRunAutonomousRetryAttempt {
    param(
        [string]$Namespace,
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$FailureClass,
        [string]$RunId = ''
    )

    if (-not $Namespace -or -not $FailureClass) {
        return @{ changed = $false; reason = 'namespace_or_class_missing' }
    }

    $ledger = Get-PostRunRetryLedger -Namespace $Namespace
    $result = Invoke-PostRunRetryLedgerCli -Subcommand 'applyPostRunRetryAttempt' -Payload @{
        ledger       = $ledger
        prNumber     = $PrNumber
        headSha      = $HeadSha
        failureClass = $FailureClass
        runId        = $RunId
    }
    if ($result.ledger) {
        Set-PostRunRetryLedger -Namespace $Namespace -Ledger $result.ledger
    }
    return $result
}

function Get-ReviewRunTerminalSortTime {
    param([object]$Run)

    $ts = if ($Run.createdAt) { [string]$Run.createdAt } elseif ($Run.startedAt) { [string]$Run.startedAt } else { '' }
    if (-not $ts) {
        return [datetime]::MinValue
    }
    $parsed = [datetime]::MinValue
    if ([datetime]::TryParse($ts, [ref]$parsed)) {
        return $parsed
    }
    return [datetime]::MinValue
}

function Register-PostRunAutonomousRetryAttemptFromClaim {
    param(
        [hashtable]$ClaimResult,
        [array]$ReviewRuns
    )

    if (-not $ClaimResult -or -not $ClaimResult.acquired) {
        return @{ changed = $false; reason = 'no_claim' }
    }

    $namespace = [string]$ClaimResult.namespace
    $prNumber = [int]$ClaimResult.claim.prNumber
    $headSha = [string]$ClaimResult.claim.headSha
    if (-not $namespace -or $prNumber -le 0 -or -not $headSha) {
        return @{ changed = $false; reason = 'claim_identity_missing' }
    }

    $failed = @($ReviewRuns | Where-Object {
            $status = [string]$_.status
            $status -in @('failed', 'cancelled') -and
            [int]$_.prNumber -eq $prNumber -and
            [string]$_.targetSha -eq $headSha
        }) | Sort-Object { Get-ReviewRunTerminalSortTime -Run $_ } -Descending | Select-Object -First 1

    if (-not $failed) {
        return @{ changed = $false; reason = 'no_failed_run_on_head' }
    }

    $failureClass = [string]$failed.failureClass
    if (-not $failureClass) {
        return @{ changed = $false; reason = 'missing_failure_class' }
    }

    return Register-PostRunAutonomousRetryAttempt -Namespace $namespace -PrNumber $prNumber `
        -HeadSha $headSha -FailureClass $failureClass -RunId ([string]$failed.id)
}

function Get-PackAoReviewRuns {
    param([string]$Project = '')

    if (Get-Command Get-AoReviewRuns -ErrorAction SilentlyContinue) {
        return @(Get-AoReviewRuns -Project $Project)
    }

    return @(& {
        . (Join-Path $PSScriptRoot 'Invoke-AoCliJson.ps1')
        Get-AoReviewRuns -Project $Project
    })
}

function Get-EnrichedAoReviewRuns {
    param(
        [string]$Project = '',
        [string]$RepoRoot = '',
        [hashtable]$EvidenceByRunId = @{},
        [string]$Namespace = ''
    )

    $runs = @(Get-PackAoReviewRuns -Project $Project)
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
    if ($Namespace) {
        $options.ledger = Get-PostRunRetryLedger -Namespace $Namespace
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
    $ledger = Get-PostRunRetryLedger -Namespace $Namespace

    $result = Invoke-PostRunRetryLedgerCli -Subcommand 'recordManualOperatorRetryAudit' -Payload @{
        ledger       = $ledger
        prNumber     = $PrNumber
        headSha      = $HeadSha
        failureClass = $FailureClass
        runId        = $RunId
    }

    if ($result.ledger) {
        Set-PostRunRetryLedger -Namespace $Namespace -Ledger $result.ledger
    }
    return $result
}
