#requires -Version 5.1

function Write-AoEventsCorrelationDegraded {
    param(
        [string]$Surface = '',
        [string]$LogPrefix = ''
    )

    if (-not (Get-Command Get-AoEventsDegradedClassification -ErrorAction SilentlyContinue)) {
        return
    }
    $classification = Get-AoEventsDegradedClassification
    if (-not $classification.degraded) {
        return
    }
    $reason = [string]$classification.reason
    if (-not $reason) { $reason = [string]$classification.classification }
    if (-not $reason) { $reason = 'removed_cli_surface' }
    $surfaceText = if ($Surface) { " surface=$Surface" } else { '' }
    $message = "degraded_correlation reason=$reason$surfaceText"
    if ($LogPrefix) {
        Write-Host "$LogPrefix: $message"
    }
    else {
        Write-Host $message
    }
}
