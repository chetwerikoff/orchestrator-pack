#requires -Version 5.1
<#
.SYNOPSIS
  Invokable adoption preflight for journaled worker sends (Issues #281 / #373).
#>

. (Join-Path $PSScriptRoot 'Record-WorkerMessageDispatch.ps1')
. (Join-Path $PSScriptRoot 'MechanicalReconcileNode.ps1')

function Get-WorkerMessageSendAdoptionPreflightStatePath {
    param([string]$Path)
    if ($Path) { return $Path }
    if ($env:AO_WORKER_MESSAGE_ADOPTION_STATE) { return $env:AO_WORKER_MESSAGE_ADOPTION_STATE }
    return Join-Path ([System.IO.Path]::GetTempPath()) 'orchestrator-worker-message-send-adoption.json'
}

function ConvertTo-WorkerMessageSafeHashText {
    param([string]$Value)
    return ConvertTo-WorkerMessageSafeIdComponent -Value $Value
}

function New-WorkerMessageAdoptionProbePayload {
    param(
        [string]$Branch,
        [string]$EpochHash,
        [string]$ConfigHash,
        [string]$RunIdHash = ''
    )

    if ($Branch -match ':self-submitted$') {
        return "AO_WORKER_MESSAGE_ADOPTION_PROBE_V1 b=$Branch e=$EpochHash c=$ConfigHash r=$RunIdHash"
    }

    $filler = 'x' * 240
    return "AO_WORKER_MESSAGE_ADOPTION_PROBE_V1`nbranch=$Branch`naoEpochHash=$EpochHash`nconfigPathHash=$ConfigHash`nadoptionProbeRunIdHash=$RunIdHash`n$filler"
}

function Invoke-AoSendProbeViaFile {
    param(
        [string]$AoPath,
        [string]$SessionId,
        [string]$Payload,
        [switch]$NoWait
    )

    $payloadFile = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($payloadFile, $Payload)
        $args = @('send', $SessionId, '--file', $payloadFile)
        if ($NoWait) { $args += '--no-wait' }
        $output = & $AoPath @args 2>&1
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        return @{ output = @($output); exitCode = $exitCode }
    }
    finally {
        Remove-Item -LiteralPath $payloadFile -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-WorkerMessageAdoptionProbeGeneration {
    param(
        [string[]]$RequiredBranches,
        [string]$AoPath,
        [string]$AoEpoch,
        [string]$ConfigPath,
        [string]$EffectiveJournalPath,
        [ref]$ProbeRunIdHash
    )

    $ProbeRunIdHash.Value = ConvertTo-WorkerMessageSafeHashText ([guid]::NewGuid().ToString('n'))
    foreach ($branch in $RequiredBranches) {
        $savedEnv = @{}
        foreach ($name in @(
            'AO_WORKER_MESSAGE_ADOPTION_PROBE',
            'AO_WORKER_MESSAGE_ADOPTION_BRANCH',
            'AO_WORKER_MESSAGE_ADOPTION_EPOCH_HASH',
            'AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH_HASH',
            'AO_WORKER_MESSAGE_ADOPTION_RUN_ID_HASH',
            'AO_WORKER_MESSAGE_DISPATCH_JOURNAL'
        )) {
            $savedEnv[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
        }
        $probeOutput = @()
        $probeExit = 1
        try {
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_PROBE', '1', 'Process')
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_BRANCH', $branch, 'Process')
            $epochHash = ConvertTo-WorkerMessageSafeHashText $AoEpoch
            $configHash = ConvertTo-WorkerMessageSafeHashText $ConfigPath
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_EPOCH_HASH', $epochHash, 'Process')
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_CONFIG_PATH_HASH', $configHash, 'Process')
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_ADOPTION_RUN_ID_HASH', $ProbeRunIdHash.Value, 'Process')
            [System.Environment]::SetEnvironmentVariable('AO_WORKER_MESSAGE_DISPATCH_JOURNAL', $EffectiveJournalPath, 'Process')
            $probePayload = New-WorkerMessageAdoptionProbePayload -Branch $branch -EpochHash $epochHash -ConfigHash $configHash -RunIdHash $ProbeRunIdHash.Value
            $sendResult = Invoke-AoSendProbeViaFile -AoPath $AoPath -SessionId 'synthetic-adoption-probe' -Payload $probePayload -NoWait
            $probeOutput = $sendResult.output
            $probeExit = [int]$sendResult.exitCode
        }
        catch {
            $probeOutput = @($_.Exception.Message)
            $probeExit = 1
        }
        finally {
            foreach ($entry in $savedEnv.GetEnumerator()) {
                [System.Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, 'Process')
            }
        }
        if ($probeExit -ne 0) {
            $diagnostic = ($probeOutput | ForEach-Object { $_.ToString() }) -join ' '
            return @{
                ok = $false
                reason = 'wrapper_not_adopted'
                branch = $branch
                exitCode = $probeExit
                diagnostic = $diagnostic
            }
        }
    }

    return @{ ok = $true }
}

function Test-WorkerMessageSendAdoptionPreflight {
    param(
        [string]$JournalPath = '',
        [string]$StateFile = '',
        [string]$AoEpoch = '',
        [string]$ConfigPath = '',
        [switch]$WriteProbeEntries,
        [string]$AoPath = 'ao',
        [string[]]$RequiredBranches = @('plain-ao-send:pending-draft', 'plain-ao-send:self-submitted'),
        [switch]$DryRun,
        [switch]$PersistState
    )

    $probeRunIdHash = ''
    $effectiveJournalPath = if ($JournalPath) { $JournalPath } else { Get-WorkerMessageDispatchJournalPath }
    $statePath = Get-WorkerMessageSendAdoptionPreflightStatePath -Path $StateFile
    if ($DryRun) {
        $root = Join-Path ([System.IO.Path]::GetTempPath()) 'worker-message-send-adoption-dryrun'
        if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
        $statePath = Join-Path $root 'adoption-state.json'
        $effectiveJournalPath = Join-Path $root 'dispatch-journal.json'
    }

    if ($WriteProbeEntries) {
        $probeRunRef = [ref]$probeRunIdHash
        $generation = Invoke-WorkerMessageAdoptionProbeGeneration `
            -RequiredBranches $RequiredBranches `
            -AoPath $AoPath `
            -AoEpoch $AoEpoch `
            -ConfigPath $ConfigPath `
            -EffectiveJournalPath $effectiveJournalPath `
            -ProbeRunIdHash $probeRunRef
        if (-not $generation.ok) {
            return @{
                ok = $false
                reason = $generation.reason
                diagnosis = "[worker-message-send-adoption-preflight] ESCALATION: wrapper_not_adopted probe_route_failed branch=$($generation.branch) exit=$($generation.exitCode) diagnostic=$($generation.diagnostic)"
                exitCode = 46
            }
        }
        $probeRunIdHash = $probeRunRef.Value
    }

    $journal = Get-WorkerMessageDispatchJournal -Path $effectiveJournalPath
    if (-not (Test-MechanicalJsonStateFencesTrusted -State $journal)) {
        return @{
            ok = $false
            reason = 'wrapper_not_adopted'
            diagnosis = '[worker-message-send-adoption-preflight] ESCALATION: wrapper_not_adopted dispatch journal corrupt/untrusted; failing closed'
            exitCode = 46
        }
    }

    $seen = @{}
    foreach ($key in @($journal.Keys)) {
        if (Test-MechanicalJsonReflectionKey -Key ([string]$key)) { continue }
        $record = ConvertTo-MechanicalJsonMap -Value $journal[$key]
        if (-not [bool]$record['adoptionProbe']) { continue }
        $epochOk = (-not $AoEpoch) -or ($record.ContainsKey('aoEpochHash') -and [string]$record['aoEpochHash'] -eq (ConvertTo-WorkerMessageSafeHashText $AoEpoch))
        $configOk = (-not $ConfigPath) -or ($record.ContainsKey('configPathHash') -and [string]$record['configPathHash'] -eq (ConvertTo-WorkerMessageSafeHashText $ConfigPath))
        $runOk = (-not $WriteProbeEntries) -or ($record.ContainsKey('adoptionProbeRunIdHash') -and [string]$record['adoptionProbeRunIdHash'] -eq $probeRunIdHash)
        $outcomeOk = $record.ContainsKey('dispatchOutcome') -and [string]$record['dispatchOutcome'] -eq 'dispatched'
        if (-not ($epochOk -and $configOk -and $runOk -and $outcomeOk)) { continue }
        $branch = [string]$record['sourceKey']
        if ($branch) { $seen[$branch] = $true }
    }

    $missing = @()
    foreach ($branch in $RequiredBranches) {
        $safe = ConvertTo-WorkerMessageSafeHashText $branch
        if (-not $seen.ContainsKey($safe) -and -not $seen.ContainsKey($branch)) { $missing += $branch }
    }

    $epochHash = ConvertTo-WorkerMessageSafeHashText $AoEpoch
    $configHash = ConvertTo-WorkerMessageSafeHashText $ConfigPath

    if ($missing.Count -gt 0) {
        if ($PersistState) {
            $failState = @{
                lastCheckedAt = (Get-Date).ToString('o')
                status = 'wrapper_not_adopted'
                missingBranchCount = $missing.Count
                aoEpochHash = $epochHash
                configPathHash = $configHash
            }
            Set-MechanicalJsonStateFile -Path $statePath -State $failState -DefaultState @{} -JsonDepth 10
        }
        return @{
            ok = $false
            reason = 'wrapper_not_adopted'
            diagnosis = "[worker-message-send-adoption-preflight] ESCALATION: wrapper_not_adopted missing branch count=$($missing.Count) under current AO epoch/config"
            exitCode = 46
            aoEpochHash = $epochHash
            configPathHash = $configHash
        }
    }

    if ($PersistState) {
        $okState = @{
            lastValidatedAt = (Get-Date).ToString('o')
            status = 'adopted'
            aoEpochHash = $epochHash
            configPathHash = $configHash
            branchCount = $RequiredBranches.Count
        }
        Set-MechanicalJsonStateFile -Path $statePath -State $okState -DefaultState @{} -JsonDepth 10
    }

    return @{
        ok = $true
        reason = 'adopted'
        aoEpochHash = $epochHash
        configPathHash = $configHash
        exitCode = 0
    }
}
