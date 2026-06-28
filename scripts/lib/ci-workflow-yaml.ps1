#requires -Version 5.1
<#
.SYNOPSIS
  Shared GitHub Actions workflow YAML helpers for CI guard scripts.
#>

function Get-YamlJobs {
    param([string]$Text)
    $jobs = @{}
    if ($Text -notmatch '(?ms)^jobs:\s*\r?\n(?<body>.*)\z') {
        return $jobs
    }
    $body = $Matches['body']
    $lines = $body -split '\r?\n'
    $current = $null
    $buffer = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $lines) {
        if ($line -match '^  ([A-Za-z0-9_-]+):\s*$') {
            if ($current) {
                $jobs[$current] = ($buffer -join "`n")
            }
            $current = $Matches[1]
            $buffer = [System.Collections.Generic.List[string]]::new()
            continue
        }
        if ($current) {
            $buffer.Add($line) | Out-Null
        }
    }
    if ($current) {
        $jobs[$current] = ($buffer -join "`n")
    }
    return $jobs
}

function Get-JobDisplayName {
    param([string]$JobText)
    if ($JobText -match '(?m)^\s*name:\s*(.+)$') {
        return $Matches[1].Trim()
    }
    return ''
}
