#requires -Version 5.1
<#
.SYNOPSIS
  Static guard: forbid $Pid parameter names in scripts/**/*.ps1 (Issue #534).

  PowerShell treats $Pid and $PID as the same symbol; $PID is automatic and read-only.
#>
param(
    [string]$ScriptsRoot = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if (-not $ScriptsRoot) {
    $ScriptsRoot = Join-Path $Root 'scripts'
}

function Test-ParamSegmentDeclaresPid {
    param([string]$Segment)

    $trimmed = $Segment.Trim()
    if (-not $trimmed) { return $false }
    return $trimmed -match '(?i)^(?:\[[^\]]+\]\s*)*\$pid\b'
}

function Test-ParamInnerDeclaresPid {
    param([string]$ParamInner)

    foreach ($segment in ($ParamInner -split ',')) {
        if (Test-ParamSegmentDeclaresPid -Segment $segment) {
            return $true
        }
    }
    return $false
}

function Test-PidParamDeclaration {
    param([string]$Content)

    $paramPattern = [regex]'(?is)\bparam\s*\((?<params>.*?)\)'
    foreach ($match in $paramPattern.Matches($Content)) {
        if (Test-ParamInnerDeclaresPid -ParamInner $match.Groups['params'].Value) {
            return $true
        }
    }

    $functionPattern = [regex]'(?is)\bfunction\s+\S+\s*\((?<params>[^)]*)\)'
    foreach ($match in $functionPattern.Matches($Content)) {
        if (Test-ParamInnerDeclaresPid -ParamInner $match.Groups['params'].Value) {
            return $true
        }
    }

    return $false
}

$violations = @()
Get-ChildItem -LiteralPath $ScriptsRoot -Filter '*.ps1' -Recurse -File | ForEach-Object {
    $content = Get-Content -LiteralPath $_.FullName -Raw
    if (Test-PidParamDeclaration -Content $content) {
        if ($_.FullName.StartsWith($ScriptsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $relative = $_.FullName.Substring($ScriptsRoot.Length).TrimStart([char]'\', [char]'/')
        }
        else {
            $relative = $_.FullName
        }
        $violations += $relative
    }
}

if ($violations.Count -gt 0) {
    Write-Host '[FAIL] PowerShell $Pid parameter declarations found (Issue #534):'
    foreach ($file in $violations) {
        Write-Host "  $file"
    }
    exit 1
}

Write-Host '[PASS] PowerShell $Pid parameter static guard (Issue #534)'
exit 0
