#requires -Version 5.1
param([string[]]$Args)

$ErrorActionPreference = 'Stop'

$claimPath = [string]$env:AO_REVIEW_START_TEST_CLAIM_PATH
$pidFile = [string]$env:AO_REVIEW_START_TEST_CHILD_PID_FILE
if ($claimPath -and (Test-Path -LiteralPath $claimPath)) {
    . (Join-Path $PSScriptRoot '../../lib/Review-StartClaim.ps1')
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $record = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        $record = Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
        $pidValue = 0
        if ($record.activeInfraPause -and [int]::TryParse([string]$record.activeInfraPause.supervisedGhPid, [ref]$pidValue) -and $pidValue -gt 0) {
            break
        }
        Start-Sleep -Milliseconds 50
    }
    if (-not $record) {
        $record = Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
    }
    $record.holder = New-ReviewStartClaimHolder -Surface 'claim-thief'
    ($record | ConvertTo-Json -Compress -Depth 20) | Set-Content -LiteralPath $claimPath -Encoding UTF8
}
if ($pidFile) {
    Set-Content -LiteralPath $pidFile -Value ([string]$PID) -Encoding ASCII -NoNewline
}
Start-Sleep -Seconds 120
Write-Output '[]'
exit 0
