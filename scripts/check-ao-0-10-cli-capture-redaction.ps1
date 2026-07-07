#requires -Version 7.0
<#
.SYNOPSIS
  Secret/path redaction gate for AO 0.10 CLI captures (Issue #619 AC#12; extended #637).
#>
[CmdletBinding()]
param(
    [string]$CaptureDir
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$DefaultCaptureDir = Join-Path $Root 'tests/external-output-references/captures/ao-0-10-cli'

$script:AoCaptureForbiddenPatterns = @(
    '/home/che/',
    '/home/[^/]+/\.ao/',
    'Bearer\s+',
    'ghp_',
    'gho_',
    'ghu_',
    'ghs_',
    'ghr_',
    'github_pat_',
    'sk-',
    'AKIA[0-9A-Z]{16}',
  # scheme://user:secret@host — catches embedded credentials regardless of secret prefix
    '[a-zA-Z][a-zA-Z0-9+.-]*://[^:]+:[^@]+@'
)

function Get-AoCaptureForbiddenPatterns {
    return @($script:AoCaptureForbiddenPatterns)
}

function Get-AoCaptureRedactionMatches {
    param(
        [Parameter(Mandatory)]
        [string]$Text
    )

    $patternHits = New-Object System.Collections.Generic.List[string]
    foreach ($pattern in $script:AoCaptureForbiddenPatterns) {
        if ($Text -match $pattern) {
            $patternHits.Add($pattern)
        }
    }
    return $patternHits
}

function Get-AoCaptureRedactionViolations {
    param(
        [Parameter(Mandatory)]
        [string]$ScanDir
    )

    if (-not (Test-Path -LiteralPath $ScanDir -PathType Container)) {
        throw "missing capture dir: $ScanDir"
    }

    $violations = New-Object System.Collections.Generic.List[string]
    $rawFiles = Get-ChildItem -LiteralPath $ScanDir -Filter '*.raw.json' -File
    foreach ($file in $rawFiles) {
        $text = Get-Content -LiteralPath $file.FullName -Raw
        foreach ($pattern in $script:AoCaptureForbiddenPatterns) {
            if ($text -match $pattern) {
                $violations.Add("$($file.Name): matches forbidden pattern $pattern")
            }
        }
    }
    return $violations
}

function Invoke-AoCaptureRedactionGate {
    param(
        [string]$ScanDir = $DefaultCaptureDir
    )

    $violations = Get-AoCaptureRedactionViolations -ScanDir $ScanDir
    if ($violations.Count -gt 0) {
        Write-Host '[FAIL] AO 0.10 capture redaction gate (Issue #619/#637):'
        foreach ($v in $violations) { Write-Host "  - $v" }
        return 1
    }

    Write-Host '[PASS] AO 0.10 capture redaction gate (Issue #619/#637)'
    return 0
}

if ($MyInvocation.InvocationName -ne '.') {
    $targetDir = if ($CaptureDir) { $CaptureDir } else { $DefaultCaptureDir }
    exit (Invoke-AoCaptureRedactionGate -ScanDir $targetDir)
}
