#requires -Version 5.1
<#
  Shared helpers for deferred-head review re-evaluation (Issues #235, #748).
#>

. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')
. (Join-Path $PSScriptRoot 'Orchestrator-SideEffectFence.ps1')

$Script:ReviewTriggerReevalFilterCli = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/review-trigger-reeval.mjs'

function Get-ReviewTriggerReevalSideEffectLockPath {
    param([string]$StateRoot = '')

    if ($StateRoot) {
        return Join-Path $StateRoot 'review-trigger-reeval-side-effect.lock'
    }
    return Get-OrchestratorSideEffectLockPath -LockFileName 'review-trigger-reeval-side-effect.lock'
}

function Copy-ReviewTriggerReevalWatchEntriesForPlanning {
    param([object]$WatchEntries)

    $copy = @{}
    $source = ConvertTo-ReviewTriggerReevalWatchMap -WatchEntries $WatchEntries
    foreach ($key in @($source.Keys)) {
        $copy[[string]$key] = ConvertTo-MechanicalJsonStateHashtable -Value $source[$key]
    }
    return $copy
}

function Invoke-ReviewTriggerReevalFilterCli {
    param(
        [string]$Subcommand,
        [hashtable]$Payload
    )

    if ($Subcommand -ne 'planTick' -or -not $Payload.snapshotErrorsByKey) {
        return Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewTriggerReevalFilterCli `
            -Subcommand $Subcommand -Payload $Payload -Label 'review-trigger-reeval' -JsonDepth 30
    }

    # The JS planner historically evaluates watch expiry before snapshotError. For an
    # untrusted PR snapshot Issue #748 requires unknown -> retain even when the local
    # watch window elapsed. Suppress expiry only in the planning copy, then restore the
    # original deadline in the returned state so a later authoritative tick can expire it.
    $effectivePayload = ConvertTo-MechanicalJsonStateHashtable -Value $Payload
    $effectivePayload['watchEntries'] = Copy-ReviewTriggerReevalWatchEntriesForPlanning `
        -WatchEntries $Payload.watchEntries
    $effectivePayload['snapshotErrorsByKey'] = ConvertTo-MechanicalJsonMap `
        -Value $Payload.snapshotErrorsByKey

    $expiryByKey = @{}
    $watchEntries = $effectivePayload['watchEntries']
    $snapshotErrors = $effectivePayload['snapshotErrorsByKey']
    foreach ($entry in $snapshotErrors.GetEnumerator()) {
        if (-not [bool]$entry.Value) { continue }
        $key = [string]$entry.Key
        if (-not $key -or -not $watchEntries.Contains($key)) { continue }
        $watch = $watchEntries[$key]
        $expiryByKey[$key] = @{
            present = $watch.Contains('windowExpiresMs')
            value   = $watch['windowExpiresMs']
        }
        $watch['windowExpiresMs'] = 0
    }

    $result = Invoke-MechanicalNodeFilterCli -FilterCliPath $Script:ReviewTriggerReevalFilterCli `
        -Subcommand $Subcommand -Payload $effectivePayload -Label 'review-trigger-reeval' -JsonDepth 30
    if ($expiryByKey.Count -eq 0) {
        return $result
    }

    $restored = ConvertTo-MechanicalJsonStateHashtable -Value $result
    $resultEntries = Copy-ReviewTriggerReevalWatchEntriesForPlanning `
        -WatchEntries $restored['watchEntries']
    foreach ($entry in $expiryByKey.GetEnumerator()) {
        $key = [string]$entry.Key
        if (-not $resultEntries.Contains($key)) { continue }
        $watch = $resultEntries[$key]
        if ([bool]$entry.Value.present) {
            $watch['windowExpiresMs'] = $entry.Value.value
        }
        else {
            $watch.Remove('windowExpiresMs')
        }
    }
    $restored['watchEntries'] = $resultEntries
    return $restored
}

function ConvertTo-ReviewTriggerReevalWatchMap {
    param([object]$WatchEntries)

    if (-not $WatchEntries) {
        return @{}
    }
    if ($WatchEntries -is [System.Collections.IDictionary]) {
        return Copy-MechanicalJsonMap -Map $WatchEntries
    }
    return Copy-MechanicalJsonMap -Map $WatchEntries
}

function Get-FixtureReviewTriggerReevalPayload {
    param([string]$Path)

    $fixture = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $payload = @{
        openPrs       = @($fixture.openPrs)
        reviewRuns    = @($fixture.reviewRuns)
        sessions      = @($fixture.sessions)
        reviewCommand = [string]$fixture.reviewCommand
    }
    foreach ($name in @(
            'ciChecksByPr', 'requiredCheckNamesByPr', 'requiredCheckLookupFailedByPr',
            'watchEntries', 'snapshotErrorsByKey', 'issueBodiesByPr', 'terminalWatchKeys',
            'unknownWatchKeys', 'prSnapshotAuthoritative'
        )) {
        $property = $fixture.PSObject.Properties[$name]
        if ($property -and $null -ne $property.Value) {
            if ($name -in @(
                    'ciChecksByPr', 'requiredCheckNamesByPr', 'requiredCheckLookupFailedByPr',
                    'watchEntries', 'snapshotErrorsByKey', 'issueBodiesByPr'
                )) {
                $payload[$name] = ConvertTo-MechanicalJsonMap -Value $property.Value
            }
            else {
                $payload[$name] = $property.Value
            }
        }
    }
    if ($null -ne $fixture.issueBody) {
        $payload.issueBody = [string]$fixture.issueBody
    }
    if ($fixture.nowMs) {
        $payload.nowMs = [long]$fixture.nowMs
    }
    return $payload
}
