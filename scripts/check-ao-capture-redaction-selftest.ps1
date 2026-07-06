#requires -Version 7.0
<#
.SYNOPSIS
  Negative self-test for AO CLI capture redaction gate (Issue #637 AC#1–#3).
#>
$ErrorActionPreference = 'Stop'
$GateScript = Join-Path $PSScriptRoot 'check-ao-0-10-cli-capture-redaction.ps1'
. $GateScript

$fixtureDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'tests/fixtures/capture-redaction-selftest'
if (-not (Test-Path -LiteralPath $fixtureDir -PathType Container)) {
    Write-Host "[FAIL] missing fixture dir: $fixtureDir"
    exit 1
}

$tokenFamilyCases = @(
    @{ Class = 'ghp_'; Fixture = 'token-ghp.raw.json' },
    @{ Class = 'gho_'; Fixture = 'token-gho.raw.json' },
    @{ Class = 'ghu_'; Fixture = 'token-ghu.raw.json' },
    @{ Class = 'ghs_'; Fixture = 'token-ghs.raw.json' },
    @{ Class = 'ghr_'; Fixture = 'token-ghr.raw.json' },
    @{ Class = 'github_pat_'; Fixture = 'token-github-pat.raw.json' }
)

$failures = New-Object System.Collections.Generic.List[string]

foreach ($case in $tokenFamilyCases) {
    $path = Join-Path $fixtureDir $case.Fixture
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $failures.Add("missing fixture for $($case.Class): $($case.Fixture)")
        continue
    }
    $text = Get-Content -LiteralPath $path -Raw
    $matched = Get-AoCaptureRedactionMatches -Text $text
    if ($matched.Count -eq 0) {
        $failures.Add("GitHub token family class '$($case.Class)' not detected in $($case.Fixture)")
        continue
    }
    Write-Host "[PASS] detected $($case.Class) via pattern(s): $($matched -join ', ')"
}

$credentialFixture = Join-Path $fixtureDir 'credential-in-url.raw.json'
if (-not (Test-Path -LiteralPath $credentialFixture -PathType Leaf)) {
    $failures.Add('missing fixture: credential-in-url.raw.json')
}
else {
    $credentialText = Get-Content -LiteralPath $credentialFixture -Raw
    $credentialMatches = Get-AoCaptureRedactionMatches -Text $credentialText
    $urlPattern = '[a-zA-Z][a-zA-Z0-9+.-]*://[^:]+:[^@]+@'
    if ($credentialMatches -notcontains $urlPattern) {
        $failures.Add('credential-in-URL class not detected (expected scheme://user:secret@host pattern)')
    }
    elseif ($credentialText -match 'ghp_|gho_|ghu_|ghs_|ghr_|github_pat_') {
        $failures.Add('credential-in-URL fixture must not contain GitHub token-family prefixes')
    }
    else {
        Write-Host "[PASS] detected credential-in-URL via pattern: $urlPattern"
    }
}

$tempRoot = if ($env:TEMP) { $env:TEMP } elseif ($env:TMPDIR) { $env:TMPDIR } else { '/tmp' }
$tempScanDir = Join-Path $tempRoot ("ao-capture-redaction-selftest-$([guid]::NewGuid())")
try {
    New-Item -ItemType Directory -Path $tempScanDir | Out-Null
    Copy-Item -LiteralPath $credentialFixture -Destination (Join-Path $tempScanDir 'leak.raw.json')
    $dirViolations = Get-AoCaptureRedactionViolations -ScanDir $tempScanDir
    if ($dirViolations.Count -eq 0) {
        $failures.Add('out-of-dir scan did not detect credential-in-URL fixture')
    }
    else {
        Write-Host '[PASS] out-of-dir gate scan detects forbidden fixture'
    }
}
finally {
    Remove-Item -LiteralPath $tempScanDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    Write-Host '[FAIL] AO capture redaction self-test (Issue #637):'
    foreach ($f in $failures) { Write-Host "  - $f" }
    exit 1
}

Write-Host '[PASS] AO capture redaction self-test (Issue #637)'
exit 0
