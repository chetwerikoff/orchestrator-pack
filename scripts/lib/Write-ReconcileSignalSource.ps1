#requires -Version 5.1

function Write-ReconcileSignalSource {
    param(
        [string]$Surface = '',
        [string]$Source = '',
        [string]$LogPrefix = ''
    )

    $surfaceText = if ($Surface) { " surface=$Surface" } else { '' }
    $sourceText = if ($Source) { " source=$Source" } else { '' }
    $message = "signal_source$surfaceText$sourceText"
    if ($LogPrefix) {
        Write-Host "${LogPrefix}: $message"
    }
    else {
        Write-Host $message
    }
}

function Write-ReconcileJournalWriteDegraded {
    param(
        [string]$Surface = '',
        [string]$Key = '',
        [string]$LogPrefix = ''
    )

    $surfaceText = if ($Surface) { " surface=$Surface" } else { '' }
    $keyText = if ($Key) { " key=$Key" } else { '' }
    $message = "journal_write_degraded$surfaceText$keyText"
    if ($LogPrefix) {
        Write-Host "${LogPrefix}: $message"
    }
    else {
        Write-Host $message
    }
}

function Test-ReconcileReactionDispatchDefer {
    param(
        [bool]$ReactionConfigUnavailable,
        [hashtable]$DispatchJournal = @{}
    )

    if (-not $ReactionConfigUnavailable) {
        return $false
    }

    foreach ($entry in @($DispatchJournal.Values)) {
        if ([string]$entry.source -eq 'reaction') {
            return $true
        }
    }
    return $false
}
