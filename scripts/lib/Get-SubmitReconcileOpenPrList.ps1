#requires -Version 5.1

function Get-SubmitReconcileOpenPrList {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackRoot,
        [scriptblock]$WriteLog = { param($Message) Write-Output $Message }
    )

    try {
        return @(Invoke-GhOpenPrList -RepoRoot $PackRoot)
    }
    catch {
        $null = & $WriteLog "open PR lookup unavailable: $_; continuing with empty openPrs (vanish drift suppression fail-closed)"
        return @()
    }
}
