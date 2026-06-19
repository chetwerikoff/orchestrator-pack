#requires -Version 5.1

function Get-SubmitReconcileOpenPrList {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackRoot,
        [scriptblock]$WriteLog = { param($Message) Write-Output $Message }
    )

    Push-Location -LiteralPath $PackRoot
    try {
        # Vanish drift suppression only needs PR numbers; skip per-PR commit lookups.
        $raw = gh pr list --state open --json number --limit 200 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "gh pr list failed (exit $LASTEXITCODE): $raw"
        }

        return @($raw | ConvertFrom-Json)
    }
    catch {
        $null = & $WriteLog "open PR lookup unavailable: $_; continuing with empty openPrs (vanish drift suppression fail-closed)"
        return @()
    }
    finally {
        Pop-Location
    }
}
