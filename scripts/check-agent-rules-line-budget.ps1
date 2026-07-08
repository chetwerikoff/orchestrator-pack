#requires -Version 5.1
<#
.SYNOPSIS
  Byte/line budget ceiling guard for AGENTS.md (Issue #678).
#>
param(
    [string]$RepoRoot,
    [int]$MaxLines = 450,
    [int]$MaxBytes = 28672
)

. (Join-Path $PSScriptRoot 'lib/Initialize-PackGateCheck.ps1')
$gate = Initialize-PackGateCheck -RepoRoot $RepoRoot -CallerScriptRoot $PSScriptRoot
$RepoRoot = $gate.RepoRoot

$target = Join-Path $RepoRoot 'AGENTS.md'
if (-not (Test-Path -LiteralPath $target)) {
    Write-Host '[FAIL] missing AGENTS.md'
    exit 1
}

$content = Get-Content -LiteralPath $target -Raw
$lineCount = ($content -split "`n").Count
$byteCount = [System.Text.Encoding]::UTF8.GetByteCount($content)

$failures = [System.Collections.Generic.List[string]]::new()
if ($lineCount -gt $MaxLines) {
    $failures.Add("AGENTS.md has $lineCount lines (ceiling $MaxLines)")
}
if ($byteCount -gt $MaxBytes) {
    $failures.Add("AGENTS.md has $byteCount bytes (ceiling $MaxBytes)")
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] AGENTS.md size budget:'
    foreach ($item in $failures) {
        Write-Host " - $item"
    }
    exit 1
}

Write-Host "[PASS] AGENTS.md size budget ($lineCount lines, $byteCount bytes)"
exit 0
