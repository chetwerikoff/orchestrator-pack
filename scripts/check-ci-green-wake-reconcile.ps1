#requires -Version 5.1
<#
.SYNOPSIS
  Regression guard: CI-green worker wake runtime wiring and cadence.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$wakeScript = Join-Path $Root 'scripts/ci-green-wake-reconcile.ps1'
$wakeMjs = Join-Path $Root 'docs/ci-green-wake-reconcile.mjs'

foreach ($path in @($wakeScript, $wakeMjs)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Missing required path: $path"
        exit 1
    }
}

$scriptText = Get-Content -LiteralPath $wakeScript -Raw
$mjs = Get-Content -LiteralPath $wakeMjs -Raw

if ($mjs -notmatch 'DEFAULT_CI_GREEN_WAKE_INTERVAL_MS = 60 \* 1000') {
    Write-Host 'docs/ci-green-wake-reconcile.mjs must default to 1-minute interval'
    exit 1
}

foreach ($marker in @(
        'lib/Ci-Green-Wake-MechanicalForbiddenCommand.ps1',
        'Test-CiGreenWakeMechanicalForbiddenCommand -CommandLine $commandLine'
    )) {
    if ($scriptText -notmatch [regex]::Escape($marker)) {
        Write-Host "ci-green wake production path missing mechanical command fence: $marker"
        exit 1
    }
}

$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(
    $scriptText,
    [ref]$tokens,
    [ref]$parseErrors
)
if (@($parseErrors).Count -gt 0) {
    Write-Host 'ci-green wake production path could not be parsed for forbidden commands'
    exit 1
}

# Preserve executable strings and command text, but remove comments so an explicit
# safety statement such as "never ao spawn" cannot trip the runtime guard.
$codeChars = $scriptText.ToCharArray()
foreach ($token in @($tokens | Where-Object {
            $_.Kind -eq [System.Management.Automation.Language.TokenKind]::Comment
        })) {
    for ($index = $token.Extent.StartOffset; $index -lt $token.Extent.EndOffset; $index++) {
        $codeChars[$index] = ' '
    }
}
$codeText = -join $codeChars

foreach ($forbidden in @('ao spawn', '--claim-pr', 'ao session kill')) {
    if ($codeText -match [regex]::Escape($forbidden)) {
        Write-Host "ci-green wake executable path contains forbidden command: $forbidden"
        exit 1
    }
}

Write-Host '[PASS] CI-green worker wake runtime wiring and cadence'
exit 0
