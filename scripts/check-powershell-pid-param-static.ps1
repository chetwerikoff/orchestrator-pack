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

function Get-BalancedParenInner {
    param(
        [string]$Content,
        [int]$OpenParenIndex
    )

    if ($OpenParenIndex -lt 0 -or $OpenParenIndex -ge $Content.Length -or $Content[$OpenParenIndex] -ne '(') {
        return $null
    }

    $depth = 0
    for ($i = $OpenParenIndex; $i -lt $Content.Length; $i++) {
        switch ($Content[$i]) {
            '(' { $depth++ }
            ')' {
                $depth--
                if ($depth -eq 0) {
                    return $Content.Substring($OpenParenIndex + 1, $i - $OpenParenIndex - 1)
                }
            }
        }
    }

    return $null
}

function Get-ParamBlockInners {
    param([string]$Content)

    $inners = @()
    $pattern = [regex]'(?is)\bparam\s*\('
    foreach ($match in $pattern.Matches($Content)) {
        $openIndex = $match.Index + $match.Length - 1
        $inner = Get-BalancedParenInner -Content $Content -OpenParenIndex $openIndex
        if ($null -ne $inner) {
            $inners += $inner
        }
    }
    return $inners
}

function Get-FunctionParamInners {
    param([string]$Content)

    $inners = @()
    $pattern = [regex]'(?is)\bfunction\s+\S+\s*\('
    foreach ($match in $pattern.Matches($Content)) {
        $openIndex = $match.Index + $match.Length - 1
        $inner = Get-BalancedParenInner -Content $Content -OpenParenIndex $openIndex
        if ($null -ne $inner) {
            $inners += $inner
        }
    }
    return $inners
}

function Split-ParamSegments {
    param([string]$ParamInner)

    $segments = @()
    $current = [System.Text.StringBuilder]::new()
    $depth = 0
    for ($i = 0; $i -lt $ParamInner.Length; $i++) {
        $ch = $ParamInner[$i]
        switch ($ch) {
            '(' { $depth++ }
            '[' { $depth++ }
            ')' { $depth-- }
            ']' { $depth-- }
        }
        if ($ch -eq ',' -and $depth -eq 0) {
            $segments += $current.ToString()
            [void]$current.Clear()
            continue
        }
        [void]$current.Append($ch)
    }
    if ($current.Length -gt 0) {
        $segments += $current.ToString()
    }
    return $segments
}

function Remove-LeadingParamSegmentComments {
    param([string]$Segment)

    $rest = $Segment
    while ($true) {
        $rest = $rest.TrimStart()
        if (-not $rest) { return '' }

        if ($rest.StartsWith('#')) {
            $newline = $rest.IndexOf("`n")
            if ($newline -lt 0) { return '' }
            $rest = $rest.Substring($newline + 1)
            continue
        }

        if ($rest.StartsWith('<#')) {
            $end = $rest.IndexOf('#>')
            if ($end -lt 0) { return '' }
            $rest = $rest.Substring($end + 2)
            continue
        }

        break
    }

    return $rest
}

function Test-ParamSegmentDeclaresPid {
    param([string]$Segment)

    $rest = Remove-LeadingParamSegmentComments -Segment $Segment
    if (-not $rest) { return $false }

    while ($rest.StartsWith('[')) {
        $depth = 0
        $consumed = $false
        for ($i = 0; $i -lt $rest.Length; $i++) {
            switch ($rest[$i]) {
                '[' { $depth++ }
                ']' {
                    $depth--
                    if ($depth -eq 0) {
                        $rest = $rest.Substring($i + 1).TrimStart()
                        $consumed = $true
                        break
                    }
                }
            }
            if ($consumed) { break }
        }
        if (-not $consumed) { return $false }
    }

    return $rest -match '(?i)^\$pid\b'
}

function Test-ParamInnerDeclaresPid {
    param([string]$ParamInner)

    foreach ($segment in (Split-ParamSegments -ParamInner $ParamInner)) {
        if (Test-ParamSegmentDeclaresPid -Segment $segment) {
            return $true
        }
    }
    return $false
}

function Test-PidParamDeclaration {
    param([string]$Content)

    foreach ($inner in (Get-ParamBlockInners -Content $Content)) {
        if (Test-ParamInnerDeclaresPid -ParamInner $inner) {
            return $true
        }
    }

    foreach ($inner in (Get-FunctionParamInners -Content $Content)) {
        if (Test-ParamInnerDeclaresPid -ParamInner $inner) {
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
