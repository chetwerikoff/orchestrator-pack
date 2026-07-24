#requires -Version 7.0
<#+
  Issue #948 passive PowerShell-to-Node transport.
  This file intentionally contains no claim interpretation, locking, lifecycle policy, or mutation.
  Every operation is executed by scripts/lib/review-start-claim-store.ts through the bounded typed CLI.
#>

# Compatibility marker for conformance inventories: review-start-claim-cli.ts
$Script:ReviewStartClaimTsCli = Join-Path $PSScriptRoot 'review-start-claim-store.ts'

function ConvertTo-ReviewStartClaimBridgeHashtable {
    param([object]$Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $result = @{}
        foreach ($key in $Value.Keys) { $result[[string]$key] = ConvertTo-ReviewStartClaimBridgeHashtable $Value[$key] }
        return $result
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $result = @{}
        foreach ($property in $Value.PSObject.Properties) { $result[$property.Name] = ConvertTo-ReviewStartClaimBridgeHashtable $property.Value }
        return $result
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object { ConvertTo-ReviewStartClaimBridgeHashtable $_ })
    }
    return $Value
}

function Sync-ReviewStartClaimBridgeResult {
    param([hashtable]$ClaimResult, [object]$Result)
    if (-not $ClaimResult -or -not $Result -or -not $Result.claimResult) { return }
    $replacement = ConvertTo-ReviewStartClaimBridgeHashtable $Result.claimResult
    $ClaimResult.Clear()
    foreach ($key in $replacement.Keys) { $ClaimResult[$key] = $replacement[$key] }
}

function Invoke-ReviewStartClaimTsOperation {
    param(
        [Parameter(Mandatory)][string]$Operation,
        [hashtable]$Payload = @{},
        [hashtable]$ClaimResult = $null
    )

    if (-not $IsLinux) { throw 'unsupported_claim_platform' }
    if (-not (Test-Path -LiteralPath $Script:ReviewStartClaimTsCli -PathType Leaf)) {
        throw "review-start claim TypeScript authority missing: $Script:ReviewStartClaimTsCli"
    }
    $node = Get-Command node -ErrorAction Stop
    $major = (& $node.Source -p 'process.versions.node.split(".")[0]').Trim()
    if ($major -ne '22') { throw "unsupported_node_major:$major" }

    $json = $Payload | ConvertTo-Json -Compress -Depth 50
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node.Source
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    [void]$start.ArgumentList.Add('--experimental-strip-types')
    [void]$start.ArgumentList.Add($Script:ReviewStartClaimTsCli)
    [void]$start.ArgumentList.Add($Operation)
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw "review-start claim TypeScript launch failed: $Operation" }
    $process.StandardInput.Write($json)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "review-start claim TypeScript operation failed ($Operation): $($stderr.Trim())"
    }
    if (-not $stdout.Trim()) { return $null }
    $result = $stdout | ConvertFrom-Json -AsHashtable -Depth 50
    Sync-ReviewStartClaimBridgeResult -ClaimResult $ClaimResult -Result $result
    return $result
}

function Resolve-ReviewStartClaimNamespace {
    param([string]$ProjectId = 'orchestrator-pack', [string]$Namespace = '')
    return Invoke-ReviewStartClaimTsOperation 'Resolve-ReviewStartClaimNamespace' @{ ProjectId = $ProjectId; Namespace = $Namespace }
}
function Get-ReviewStartClaimProjectNamespace { param([string]$ProjectId = 'orchestrator-pack') return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimProjectNamespace' @{ ProjectId = $ProjectId } }
function Get-ReviewStartClaimPath { param([string]$Namespace, [int]$PrNumber, [string]$HeadSha) return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimPath' @{ Namespace = $Namespace; PrNumber = $PrNumber; HeadSha = $HeadSha } }
function Get-ReviewStartClaimLockDir { param([string]$Namespace, [int]$PrNumber, [string]$HeadSha) return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimLockDir' @{ Namespace = $Namespace; PrNumber = $PrNumber; HeadSha = $HeadSha } }
function Get-ReviewStartClaimTerminalDir { param([string]$Namespace) return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimTerminalDir' @{ Namespace = $Namespace } }
function Get-ReviewStartClaimAuditDir { param([string]$Namespace) return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimAuditDir' @{ Namespace = $Namespace } }
function Initialize-ReviewStartClaimNamespace { param([string]$Namespace) Invoke-ReviewStartClaimTsOperation 'Initialize-ReviewStartClaimNamespace' @{ Namespace = $Namespace } | Out-Null }
function Read-ReviewStartClaimRecord { param([string]$Path) return Invoke-ReviewStartClaimTsOperation 'Read-ReviewStartClaimRecord' @{ Path = $Path } }
function Write-ReviewStartClaimAtomic { param([string]$Path, [object]$Record) Invoke-ReviewStartClaimTsOperation 'Write-ReviewStartClaimAtomic' @{ Path = $Path; Record = $Record } | Out-Null }
function New-ReviewStartClaimHolder { param([string]$Surface) return Invoke-ReviewStartClaimTsOperation 'New-ReviewStartClaimHolder' @{ Surface = $Surface; HolderContext = @{ pid = $PID; host = [System.Net.Dns]::GetHostName(); generation = if ($env:AO_CHILD_GENERATION) { $env:AO_CHILD_GENERATION } elseif ($env:AO_SESSION_ID) { $env:AO_SESSION_ID } else { '' } } } }
function New-ReviewStartClaimActiveRecord {
    param([int]$PrNumber, [string]$HeadSha, [string]$Surface, [string]$Reason = '', [object]$RecoveredFrom = $null, [int64]$PriorFirstAttemptMonotonicMs = 0)
    return Invoke-ReviewStartClaimTsOperation 'New-ReviewStartClaimActiveRecord' @{ PrNumber = $PrNumber; HeadSha = $HeadSha; Surface = $Surface; Reason = $Reason; RecoveredFrom = $RecoveredFrom; PriorFirstAttemptMonotonicMs = $PriorFirstAttemptMonotonicMs; HolderContext = @{ pid = $PID; host = [System.Net.Dns]::GetHostName(); generation = if ($env:AO_CHILD_GENERATION) { $env:AO_CHILD_GENERATION } elseif ($env:AO_SESSION_ID) { $env:AO_SESSION_ID } else { '' } } }
}
function Get-ReviewStartClaimVisibleRunId { param([array]$ReviewRuns, [int]$PrNumber, [string]$HeadSha) return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimVisibleRunId' @{ ReviewRuns = @($ReviewRuns); PrNumber = $PrNumber; HeadSha = $HeadSha } }
function Format-ReviewStartClaimHolder { param([object]$Holder) return Invoke-ReviewStartClaimTsOperation 'Format-ReviewStartClaimHolder' @{ Holder = $Holder } }
function Get-ReviewStartClaimStaleMinutes {
    param([scriptblock]$LogWriter = $null)
    $result = Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimStaleMinutes' @{ IncludeDiagnostics = $true }
    if ($LogWriter) { foreach ($message in @($result.warnings)) { & $LogWriter ([string]$message) } }
    return [int]$result.value
}
function Prune-ReviewStartClaimTerminalRecords { param([string]$Namespace) Invoke-ReviewStartClaimTsOperation 'Prune-ReviewStartClaimTerminalRecords' @{ Namespace = $Namespace } | Out-Null }

function Acquire-ReviewStartClaim {
    param([int]$PrNumber, [string]$HeadSha, [string]$Surface, [array]$ReviewRuns = @(), [string]$Namespace = '', [string]$ProjectId = 'orchestrator-pack', [string]$StartReason = '', [scriptblock]$LogWriter = $null)
    return Invoke-ReviewStartClaimTsOperation 'Acquire-ReviewStartClaim' @{
        PrNumber = $PrNumber; HeadSha = $HeadSha; Surface = $Surface; ReviewRuns = @($ReviewRuns)
        Namespace = $Namespace; ProjectId = $ProjectId; StartReason = $StartReason
        HolderContext = @{ pid = $PID; host = [System.Net.Dns]::GetHostName(); generation = if ($env:AO_CHILD_GENERATION) { $env:AO_CHILD_GENERATION } elseif ($env:AO_SESSION_ID) { $env:AO_SESSION_ID } else { '' } }
    }
}
function Test-ReviewStartClaimOwnership { param([hashtable]$ClaimResult) return [bool](Invoke-ReviewStartClaimTsOperation 'Test-ReviewStartClaimOwnership' @{ ClaimResult = $ClaimResult } $ClaimResult) }
function Test-ReviewStartClaimRunVisible { param([array]$ReviewRuns, [int]$PrNumber, [string]$HeadSha) return [bool](Invoke-ReviewStartClaimTsOperation 'Test-ReviewStartClaimRunVisible' @{ ReviewRuns = @($ReviewRuns); PrNumber = $PrNumber; HeadSha = $HeadSha }) }
function Test-ReviewStartClaimRetryEligible { param([array]$ReviewRuns, [int]$PrNumber, [string]$HeadSha) return [bool](Invoke-ReviewStartClaimTsOperation 'Test-ReviewStartClaimRetryEligible' @{ ReviewRuns = @($ReviewRuns); PrNumber = $PrNumber; HeadSha = $HeadSha }) }
function Update-ReviewStartClaimRecordFields { param([hashtable]$ClaimResult, [hashtable]$Fields, [string[]]$ClearFields = @()) return Invoke-ReviewStartClaimTsOperation 'Update-ReviewStartClaimRecordFields' @{ ClaimResult = $ClaimResult; Fields = $Fields; ClearFields = @($ClearFields) } $ClaimResult }
function Bind-ReviewStartClaimToVisibleRun { param([hashtable]$ClaimResult, [array]$ReviewRuns = @()) return Invoke-ReviewStartClaimTsOperation 'Bind-ReviewStartClaimToVisibleRun' @{ ClaimResult = $ClaimResult; ReviewRuns = @($ReviewRuns) } $ClaimResult }
function Complete-ReviewStartClaim { param([hashtable]$ClaimResult, [string]$Outcome, [array]$ReviewRuns = @(), [hashtable]$Extra = @{}) return Invoke-ReviewStartClaimTsOperation 'Complete-ReviewStartClaim' @{ ClaimResult = $ClaimResult; Outcome = $Outcome; ReviewRuns = @($ReviewRuns); Extra = $Extra } $ClaimResult }
function Release-ReviewStartClaimAfterRunFailure { param([hashtable]$ClaimResult, [array]$ReviewRuns = @(), [string]$Failure = '') return Invoke-ReviewStartClaimTsOperation 'Release-ReviewStartClaimAfterRunFailure' @{ ClaimResult = $ClaimResult; ReviewRuns = @($ReviewRuns); Failure = $Failure } $ClaimResult }
function Complete-ReviewStartClaimPreRunRecheckDenied { param([hashtable]$ClaimResult, [hashtable]$Recheck, [array]$ReviewRuns = @(), [switch]$DryRun) return Invoke-ReviewStartClaimTsOperation 'Complete-ReviewStartClaimPreRunRecheckDenied' @{ ClaimResult = $ClaimResult; Recheck = $Recheck; ReviewRuns = @($ReviewRuns); DryRun = [bool]$DryRun } $ClaimResult }
function Release-ReviewStartClaimAfterRecheckException { param([hashtable]$ClaimResult, [switch]$DryRun, [object]$ErrorRecord) return Invoke-ReviewStartClaimTsOperation 'Release-ReviewStartClaimAfterRecheckException' @{ ClaimResult = $ClaimResult; DryRun = [bool]$DryRun; ErrorRecord = [string]$ErrorRecord } $ClaimResult }
function Release-ReviewStartClaimForTerminalizedRun { param([int]$PrNumber, [string]$HeadSha, [string]$ProjectId = 'orchestrator-pack', [string]$Namespace = '', [string]$RunId = '', [string]$RunCreatedAtUtc = '', [array]$ReviewRuns = @(), [scriptblock]$LogWriter = $null) return Invoke-ReviewStartClaimTsOperation 'Release-ReviewStartClaimForTerminalizedRun' @{ PrNumber = $PrNumber; HeadSha = $HeadSha; ProjectId = $ProjectId; Namespace = $Namespace; RunId = $RunId; RunCreatedAtUtc = $RunCreatedAtUtc; ReviewRuns = @($ReviewRuns) } }
function Resolve-ReviewStartClaimEscalation { param([int]$PrNumber, [string]$HeadSha, [array]$ReviewRuns = @(), [string]$Namespace = '', [string]$ProjectId = 'orchestrator-pack', [scriptblock]$LogWriter = $null) return Invoke-ReviewStartClaimTsOperation 'Resolve-ReviewStartClaimEscalation' @{ PrNumber = $PrNumber; HeadSha = $HeadSha; ReviewRuns = @($ReviewRuns); Namespace = $Namespace; ProjectId = $ProjectId } }

function Get-ReviewStartClaimLocalHostName { return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimLocalHostName' @{} }
function Get-ReviewStartClaimLifecycleConfig { return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimLifecycleConfig' @{} }
function Invoke-ReviewStartClaimLifecycleCli { param([string]$Subcommand, [hashtable]$Payload) return Invoke-ReviewStartClaimTsOperation 'Invoke-ReviewStartClaimLifecycleCli' @{ Subcommand = $Subcommand; Payload = $Payload } }
function Set-ReviewStartClaimHoldStarted { param([hashtable]$ClaimResult) return Invoke-ReviewStartClaimTsOperation 'Set-ReviewStartClaimHoldStarted' @{ ClaimResult = $ClaimResult } $ClaimResult }
function Set-ReviewStartClaimLaunchPending { param([hashtable]$ClaimResult, [int]$BudgetMs = 0) return Invoke-ReviewStartClaimTsOperation 'Set-ReviewStartClaimLaunchPending' @{ ClaimResult = $ClaimResult; BudgetMs = $BudgetMs } $ClaimResult }
function Confirm-ReviewStartClaimLaunchGate { param([hashtable]$ClaimResult, [array]$ReviewRuns = @(), [string]$DecisionSource = 'hold_budget', [scriptblock]$LogWriter = $null) return Invoke-ReviewStartClaimTsOperation 'Confirm-ReviewStartClaimLaunchGate' @{ ClaimResult = $ClaimResult; ReviewRuns = @($ReviewRuns); DecisionSource = $DecisionSource } $ClaimResult }
function Get-ReviewStartClaimActiveRecords { param([string]$Namespace) return @(Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartClaimActiveRecords' @{ Namespace = $Namespace }) }
function Invoke-ReviewStartClaimReaperSweep { param([string]$Namespace = '', [string]$ProjectId = 'orchestrator-pack', [array]$ReviewRuns = @(), [scriptblock]$LogWriter = $null) return Invoke-ReviewStartClaimTsOperation 'Invoke-ReviewStartClaimReaperSweep' @{ Namespace = $Namespace; ProjectId = $ProjectId; ReviewRuns = @($ReviewRuns) } }
function Test-ReviewStartClaimHoldBudgetExceeded { param([hashtable]$ClaimResult) return Invoke-ReviewStartClaimTsOperation 'Test-ReviewStartClaimHoldBudgetExceeded' @{ ClaimResult = $ClaimResult } $ClaimResult }
function Complete-ReviewStartClaimAfterRunInvoke {
    param([hashtable]$ClaimResult, [array]$ReviewRuns = @(), [scriptblock]$ResolveReviewRuns = $null, [scriptblock]$LogWriter = $null)
    $runs = @($ReviewRuns)
    while ($true) {
        if ($ResolveReviewRuns) { $runs = @(& $ResolveReviewRuns) }
        $result = Invoke-ReviewStartClaimTsOperation 'Complete-ReviewStartClaimAfterRunInvoke' @{
            ClaimResult = $ClaimResult
            ReviewRuns = $runs
            PollOnce = $true
        } $ClaimResult
        if ($result.ok -or [string]$result.reason -ne 'visibility_pending') { return $result }
        if ($LogWriter) { & $LogWriter "review-start-claim: waiting for post-invoke visibility key=$($ClaimResult.key)" }
        Start-Sleep -Milliseconds ([Math]::Max(1, [int]$result.waitMs))
    }
}
function Wait-ReviewStartClaimPostInvokeVisibility { param([hashtable]$ClaimResult, [array]$ReviewRuns = @(), [scriptblock]$ResolveReviewRuns = $null, [scriptblock]$LogWriter = $null) return Complete-ReviewStartClaimAfterRunInvoke -ClaimResult $ClaimResult -ReviewRuns $ReviewRuns -ResolveReviewRuns $ResolveReviewRuns -LogWriter $LogWriter }
function Start-ReviewStartClaimInfraPause { param([hashtable]$ClaimResult, [int]$SupervisedGhPid = 0) return Invoke-ReviewStartClaimTsOperation 'Start-ReviewStartClaimInfraPause' @{ ClaimResult = $ClaimResult; SupervisedGhPid = $SupervisedGhPid } $ClaimResult }
function Complete-ReviewStartClaimInfraPause { param([hashtable]$ClaimResult, [string]$Stderr = '', [switch]$TimedOut, [hashtable]$Classification = $null) return Invoke-ReviewStartClaimTsOperation 'Complete-ReviewStartClaimInfraPause' @{ ClaimResult = $ClaimResult; Stderr = $Stderr; TimedOut = [bool]$TimedOut; Classification = $Classification } $ClaimResult }
function Annotate-ReviewStartClaimWorktreeAllowConsumed { param([string]$Namespace, [string]$Path, [object]$Record, [string]$CanonicalPath) return Invoke-ReviewStartClaimTsOperation 'Annotate-ReviewStartClaimWorktreeAllowConsumed' @{ Namespace = $Namespace; Path = $Path; Record = $Record; CanonicalPath = $CanonicalPath } }
function Mark-ReviewStartClaimForeignHolderBlocking { param([string]$Namespace, [string]$Path, [object]$Record, [object]$Decision, [string]$DecisionSource, [array]$ReviewRuns = @(), [scriptblock]$LogWriter = $null) return Invoke-ReviewStartClaimTsOperation 'Mark-ReviewStartClaimForeignHolderBlocking' @{ Namespace = $Namespace; Path = $Path; Record = $Record; Decision = $Decision; DecisionSource = $DecisionSource; ReviewRuns = @($ReviewRuns) } }
function Invoke-ReviewStartClaimReclaimOrphan { param([string]$Namespace, [string]$Path, [object]$Record, [array]$ReviewRuns = @(), [string]$DecisionSource = 'reclaim', [string]$ProjectId = '', [scriptblock]$LogWriter = $null) return Invoke-ReviewStartClaimTsOperation 'Invoke-ReviewStartClaimReclaimOrphan' @{ Namespace = $Namespace; Path = $Path; Record = $Record; ReviewRuns = @($ReviewRuns); DecisionSource = $DecisionSource; ProjectId = $ProjectId } }
function Sync-ReviewStartClaimReclaimBeforeSkip { param([string]$Namespace, [string]$Path, [object]$Record, [array]$ReviewRuns = @(), [scriptblock]$LogWriter = $null) return Invoke-ReviewStartClaimReclaimOrphan -Namespace $Namespace -Path $Path -Record $Record -ReviewRuns $ReviewRuns -DecisionSource 'acquire_sync' -LogWriter $LogWriter }
function Invoke-ReviewStartClaimOwnershipLossCleanup { param([hashtable]$ClaimResult) return Invoke-ReviewStartClaimTsOperation 'Invoke-ReviewStartClaimOwnershipLossCleanup' @{ ClaimResult = $ClaimResult } $ClaimResult }
function Stop-ReviewStartSupervisedGhChild { param([int]$ProcessId) return Invoke-ReviewStartClaimTsOperation 'Stop-ReviewStartSupervisedGhChild' @{ ProcessId = $ProcessId } }
function Get-ReviewStartTargetStateRecheckDenial { param([hashtable]$Snapshot) return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartTargetStateRecheckDenial' @{ Snapshot = $Snapshot } }
function Get-ReviewStartSupervisedGhInfraTransportFailure { param([object]$TransportFailure) return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartSupervisedGhInfraTransportFailure' @{ TransportFailure = $TransportFailure } }
function Get-ReviewStartSupervisedGhInfraTransportRecheckDenial { param([hashtable]$Snapshot) return Invoke-ReviewStartClaimTsOperation 'Get-ReviewStartSupervisedGhInfraTransportRecheckDenial' @{ Snapshot = $Snapshot } }
