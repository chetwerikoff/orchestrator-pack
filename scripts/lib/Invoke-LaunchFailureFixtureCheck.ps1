# Shared offline PTY fixture check for prompt-delivery launch failure (Issues #63, #91).

function Invoke-LaunchFailureFixtureCheck {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$FixturePath,
        [switch]$ExpectMatch,
        [switch]$ExpectNoMatch,
        [Parameter(Mandatory = $true)]
        [string]$RoleLabel
    )

    . (Join-Path $PSScriptRoot 'Test-WorkerLaunchFailure.ps1')

    if (-not (Test-Path -LiteralPath $FixturePath -PathType Leaf)) {
        Write-Host "[FAIL] Fixture not found: $FixturePath"
        return 1
    }

    $text = Get-Content -LiteralPath $FixturePath -Raw -Encoding UTF8
    $result = Get-WorkerLaunchFailureSignature -Text $text
    $matched = $result.IsLaunchFailure

    if ($ExpectMatch -and -not $matched) {
        Write-Host "[FAIL] Expected $RoleLabel-failure match: $FixturePath"
        return 1
    }
    if ($ExpectNoMatch -and $matched) {
        Write-Host "[FAIL] Expected no $RoleLabel-failure match: $FixturePath (got $($result.Signature))"
        return 1
    }

    if ($matched) {
        Write-Host "[PASS] $RoleLabel-failure detected ($($result.Signature)): $(Split-Path -Leaf $FixturePath)"
        foreach ($m in $result.Messages) { Write-Host "       $m" }
        return 0
    }

    Write-Host "[PASS] No $RoleLabel-failure signature: $(Split-Path -Leaf $FixturePath)"
    return 0
}
