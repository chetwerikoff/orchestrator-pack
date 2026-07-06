#requires -Version 7.0
<#
.SYNOPSIS
  Secret/path redaction gate for AO 0.10 CLI captures (Issue #619 AC#12).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$CaptureDir = Join-Path $Root 'tests/external-output-references/captures/ao-0-10-cli'

if (-not (Test-Path -LiteralPath $CaptureDir -PathType Container)) {
    Write-Host "[FAIL] missing capture dir: $CaptureDir"
    exit 1
}

$forbiddenPatterns = @(
    '/home/che/',
    '/home/[^/]+/\.ao/',
    'Bearer\s+',
    'ghp_',
    'github_pat_',
    'sk-',
    'AKIA[0-9A-Z]{16}'
)

$violations = New-Object System.Collections.Generic.List[string]
$rawFiles = Get-ChildItem -LiteralPath $CaptureDir -Filter '*.raw.json' -File
foreach ($file in $rawFiles) {
    $text = Get-Content -LiteralPath $file.FullName -Raw
    foreach ($pattern in $forbiddenPatterns) {
        if ($text -match $pattern) {
            $violations.Add("$($file.Name): matches forbidden pattern $pattern")
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] AO 0.10 capture redaction gate (Issue #619):'
    foreach ($v in $violations) { Write-Host "  - $v" }
    exit 1
}

Write-Host '[PASS] AO 0.10 capture redaction gate (Issue #619)'
exit 0
