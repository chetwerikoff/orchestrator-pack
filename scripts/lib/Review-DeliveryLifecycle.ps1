#requires -Version 5.1
<#
  Review delivery lifecycle store helpers (Issue #718).
#>

function Get-ReviewDeliveryLifecycleStorePath {
    . (Join-Path $PSScriptRoot 'Orchestrator-SideProcessSupervisor.ps1')
    $stateRoot = Get-OrchestratorWakeSupervisorStateRoot
    return Join-Path $stateRoot 'review-delivery-lifecycle.json'
}

function Invoke-ReviewDeliveryLifecycleCli {
    param(
        [Parameter(Mandatory = $true)][string]$Subcommand,
        [hashtable]$Payload = @{}
    )
    $packRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $cli = Join-Path $packRoot 'docs/review-delivery-lifecycle.mjs'
    . (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
    return Invoke-MechanicalNodeFilterCli -FilterCliPath $cli -Subcommand $Subcommand `
        -Payload $Payload -Label 'review-delivery-lifecycle' -JsonDepth 30
}

function Get-ReviewDeliveryLifecycleStore {
    param([string]$Path = '')
    $storePath = if ($Path) { $Path } else { Get-ReviewDeliveryLifecycleStorePath }
    return Invoke-ReviewDeliveryLifecycleCli -Subcommand 'read-store' -Payload @{ path = $storePath }
}

function Set-ReviewDeliveryLifecycleEntry {
    param(
        [Parameter(Mandatory = $true)][string]$DeliveryKey,
        [Parameter(Mandatory = $true)][hashtable]$Patch,
        [string]$Path = '',
        [long]$NowMs = 0
    )
    $storePath = if ($Path) { $Path } else { Get-ReviewDeliveryLifecycleStorePath }
    $payload = @{
        path        = $storePath
        deliveryKey = $DeliveryKey
        patch       = $Patch
    }
    if ($NowMs -gt 0) { $payload.nowMs = $NowMs }
    return Invoke-ReviewDeliveryLifecycleCli -Subcommand 'upsert-entry' -Payload $payload
}

function Get-ReviewDeliveryLifecycleEntry {
    param(
        [Parameter(Mandatory = $true)][string]$DeliveryKey,
        [string]$Path = ''
    )
    $storePath = if ($Path) { $Path } else { Get-ReviewDeliveryLifecycleStorePath }
    return Invoke-ReviewDeliveryLifecycleCli -Subcommand 'get-entry' -Payload @{
        path        = $storePath
        deliveryKey = $DeliveryKey
    }
}

function New-ReviewDeliveryDeterministicKey {
    param(
        [int]$PrNumber,
        [string]$HeadSha,
        [string]$VerdictSource = 'wrapper-stdout',
        [object[]]$Findings = @()
    )
    $hashResult = Invoke-ReviewDeliveryLifecycleCli -Subcommand 'hash-findings' -Payload @{
        findings = @($Findings)
    }
    return Invoke-ReviewDeliveryLifecycleCli -Subcommand 'build-delivery-key' -Payload @{
        prNumber      = $PrNumber
        headSha       = $HeadSha
        verdictSource = $VerdictSource
        findingsHash  = [string]$hashResult.findingsHash
    }
}

function New-ReviewDeliveryDeterministicDeliveryId {
    param(
        [string]$SessionId,
        [string]$DeliveryKey
    )
    return Invoke-ReviewDeliveryLifecycleCli -Subcommand 'build-delivery-id' -Payload @{
        sessionId   = $SessionId
        deliveryKey = $DeliveryKey
    }
}
