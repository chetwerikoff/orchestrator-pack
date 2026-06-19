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
        $openPrs = @()
        $page = 1
        $perPage = 100
        while ($true) {
            $raw = gh api 'repos/{owner}/{repo}/pulls' -f state=open -f per_page="$perPage" -f page="$page" 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "gh api open PR list failed on page $page (exit $LASTEXITCODE): $raw"
            }

            $batch = @($raw | ConvertFrom-Json)
            if ($batch.Count -eq 0) {
                break
            }

            foreach ($pr in $batch) {
                $openPrs += @{ number = [int]$pr.number }
            }

            if ($batch.Count -lt $perPage) {
                break
            }
            $page++
        }

        return $openPrs
    }
    catch {
        $null = & $WriteLog "open PR lookup unavailable: $_; continuing with empty openPrs (vanish drift suppression fail-closed)"
        return @()
    }
    finally {
        Pop-Location
    }
}
